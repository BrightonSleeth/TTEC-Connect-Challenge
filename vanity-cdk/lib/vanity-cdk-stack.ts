import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as connect from "aws-cdk-lib/aws-connect";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as path from "path";
import * as fs from "fs";

// Repo root, relative to this file (vanity-cdk/lib).
const REPO_ROOT = path.join(__dirname, "..", "..");
const CONVERTER_DIR = path.join(REPO_ROOT, "vanity-lambda");
const READER_DIR = path.join(REPO_ROOT, "vanity-dashboard-reader");
const SLOGAN_DIR = path.join(REPO_ROOT, "vanity-slogan-generator");
const DASHBOARD_DIR = path.join(REPO_ROOT, "vanity-dashboard");

// Secrets Manager name holding the Anthropic API key for the slogan Lambda,
// shaped as { "ANTHROPIC_API_KEY": "sk-ant-..." }.
const API_KEY_SECRET_NAME = "vanity-generator/anthropic-api-key";

// The Lambdas are plain ESM (.mjs) whose only runtime dependency is @aws-sdk/*,
// which the Node 24 runtime already provides — so we ship the source as-is with
// no bundling step. These are the files we DON'T want in the deployment package.
const LAMBDA_ASSET_EXCLUDE = ["node_modules", "tests", "*.zip", "package-lock.json"];

export class VanityCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB ─────────────────────────────────────────────────────────────
    // Sole partition key — no sort key — enforces one record per caller.
    const table = new dynamodb.Table(this, "VanityNumbers", {
      tableName: "VanityNumbers",
      partitionKey: { name: "CallerId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // preserve data on stack destroy
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
    });

    // GSI for the dashboard: every caller record carries a constant GSIPartition="ALL",
    // so all records share one partition sorted by LastCalled. The reader can then Query
    // this index (newest first, Limit 5) instead of Scanning the whole table. Only
    // VanityResults is projected; CallerId (table key) and LastCalled (sort key) come for free.
    table.addGlobalSecondaryIndex({
      indexName: "LastCalledIndex",
      partitionKey: { name: "GSIPartition", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "LastCalled", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["VanityResults"],
    });

    // ── VanityNumberConverter Lambda ─────────────────────────────────────────
    // Source lives at repo root in vanity-lambda/ as flat ESM modules
    // (index.mjs + vanity-generator.mjs + words.mjs), shipped as-is.
    const converterLambda = new lambda.Function(this, "VanityNumberConverter", {
      functionName: "VanityNumberConverter",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(CONVERTER_DIR, { exclude: LAMBDA_ASSET_EXCLUDE }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
      },
      description:
        "Converts caller phone numbers to vanity alternatives and stores results in DynamoDB.",
    });

    // Grant converter read + write access to DynamoDB
    table.grantReadWriteData(converterLambda);

    // ── VanityDashboardReader Lambda ─────────────────────────────────────────
    const readerLambda = new lambda.Function(this, "VanityDashboardReader", {
      functionName: "VanityDashboardReader",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(READER_DIR, { exclude: LAMBDA_ASSET_EXCLUDE }),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: {
        VANITY_TABLE: table.tableName,
      },
      description: "Reads last 5 unique callers from DynamoDB for the dashboard.",
    });

    // Grant reader scan-only access
    table.grantReadData(readerLambda);

    // ── Anthropic API key secret ─────────────────────────────────────────────
    // Created with a generated placeholder so `cdk deploy` is self-contained for a
    // reviewer's own account. Replace the value with a real key after deploy:
    //   aws secretsmanager put-secret-value --secret-id vanity-generator/anthropic-api-key \
    //     --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'
    // Until then the slogan Lambda falls back to canned slogans (never goes silent).
    const apiKeySecret = new secretsmanager.Secret(this, "AnthropicApiKey", {
      secretName: API_KEY_SECRET_NAME,
      description: "Anthropic API key for the SloganGenerator Lambda. Replace the placeholder value with a real key.",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "ANTHROPIC_API_KEY", // produces { "ANTHROPIC_API_KEY": "<placeholder>" }
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // just a placeholder; fine to remove with the stack
    });

    // ── SloganGenerator Lambda ───────────────────────────────────────────────
    // Invoked mid-call (press 0) to generate a marketing slogan for the caller's
    // top vanity number via the Anthropic API. Source at repo root in
    // vanity-slogan-generator/ as flat ESM (@aws-sdk/* provided by the runtime).
    const sloganLambda = new lambda.Function(this, "SloganGenerator", {
      functionName: "SloganGenerator",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(SLOGAN_DIR, { exclude: LAMBDA_ASSET_EXCLUDE }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10), // calls an external API; flow allows up to 8s
      environment: {
        SECRET_NAME: apiKeySecret.secretName,
      },
      description: "Generates a marketing slogan for a vanity number via the Anthropic API.",
    });

    // Grant the slogan Lambda read access to the API key secret only.
    apiKeySecret.grantRead(sloganLambda);

    // ── HTTP API Gateway ──────────────────────────────────────────────────────
    const api = new apigateway.HttpApi(this, "VanityDashboardAPI", {
      apiName: "VanityDashboardAPI",
      description: "Dashboard polling endpoint — GET /callers",
      corsPreflight: {
        // The dashboard reaches /callers same-origin through CloudFront, so CORS
        // is not strictly needed; kept permissive for direct API testing.
        allowOrigins: ["*"],
        allowMethods: [apigateway.CorsHttpMethod.GET, apigateway.CorsHttpMethod.OPTIONS],
        allowHeaders: ["Content-Type"],
        maxAge: cdk.Duration.seconds(300),
      },
    });

    api.addRoutes({
      path: "/callers",
      methods: [apigateway.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("ReaderIntegration", readerLambda),
    });

    // ── S3 Bucket (dashboard hosting) ────────────────────────────────────────
    const dashboardBucket = new s3.Bucket(this, "DashboardBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ── CloudFront Distribution ───────────────────────────────────────────────
    const oac = new cloudfront.S3OriginAccessControl(this, "DashboardOAC", {
      description: "OAC for vanity dashboard S3 bucket",
    });

    // API Gateway origin — routes /callers through CloudFront to avoid CORS
    const apiOrigin = new origins.HttpOrigin(
      `${api.apiId}.execute-api.${this.region}.amazonaws.com`,
      { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }
    );

    const distribution = new cloudfront.Distribution(this, "DashboardDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        // S3 serves the static dashboard HTML. Auth was removed for this demo —
        // the dashboard is publicly reachable over HTTPS.
        origin: origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        // /callers proxied to API Gateway — same domain, no CORS needed
        "/callers": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
      },
      comment: "Vanity Number Dashboard",
    });

    // ── Inject API URL into index.html and upload to S3 ──────────────────────
    // Point the dashboard's API_URL at the CloudFront /callers path. The domain is
    // only known at deploy time, so the rewritten HTML is fed through
    // s3deploy.Source.data, which resolves the CloudFront-domain token at DEPLOY
    // time. (Writing the token to a file at synth time would bake in an unresolved
    // "${Token[...]}" placeholder and break the dashboard.)
    const htmlTemplate = fs.readFileSync(path.join(DASHBOARD_DIR, "index.html"), "utf-8");
    const htmlWithUrl = htmlTemplate.replace(
      /const API_URL\s*=\s*["'].*?["'];/,
      () => `const API_URL = "https://${distribution.distributionDomainName}/callers";`
    );

    new s3deploy.BucketDeployment(this, "DashboardDeployment", {
      sources: [s3deploy.Source.data("index.html", htmlWithUrl)],
      destinationBucket: dashboardBucket,
      distribution,
      distributionPaths: ["/*"], // invalidate CloudFront cache on deploy
    });

    // ── Connect invoke permission ─────────────────────────────────────────────
    // Grant Amazon Connect permission to invoke the converter Lambda. Paste your
    // Connect instance ARN into the parameter; leave blank to add it manually later.
    const connectInstanceArn = new cdk.CfnParameter(this, "ConnectInstanceArn", {
      type: "String",
      description:
        "ARN of your Amazon Connect instance. Found in the Connect console under instance settings. " +
        "Format: arn:aws:connect:REGION:ACCOUNT_ID:instance/INSTANCE_ID. " +
        "Leave blank to skip — you can add this manually after deployment.",
      default: "",
    });

    const connectArnProvided = new cdk.CfnCondition(this, "ConnectArnProvided", {
      expression: cdk.Fn.conditionNot(
        cdk.Fn.conditionEquals(connectInstanceArn.valueAsString, "")
      ),
    });

    const connectPermission = new lambda.CfnPermission(this, "ConnectInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: converterLambda.functionName,
      principal: "connect.amazonaws.com",
      sourceArn: connectInstanceArn.valueAsString,
    });
    connectPermission.cfnOptions.condition = connectArnProvided;

    // The flow also invokes the slogan Lambda (press 0), so Connect needs to invoke it too.
    const sloganConnectPermission = new lambda.CfnPermission(this, "SloganConnectInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: sloganLambda.functionName,
      principal: "connect.amazonaws.com",
      sourceArn: connectInstanceArn.valueAsString,
    });
    sloganConnectPermission.cfnOptions.condition = connectArnProvided;

    // ── Contact flow ──────────────────────────────────────────────────────────
    // Imports "Vanity Number Flow.json" from this folder. The exported flow has
    // hard-coded Lambda ARNs, so we swap each for THIS stack's ARN. Created only
    // when an instance ARN is supplied (same condition as the invoke permissions).
    const flowJson = fs.readFileSync(
      path.join(__dirname, "..", "Vanity Number Flow.json"),
      "utf-8"
    );
    const flowContent = flowJson
      // "arn:aws:lambda:...:function:VanityNumberConverter" -> this stack's converter ARN
      .replace(/arn:aws:lambda:[^"]*:function:VanityNumberConverter/g, () => converterLambda.functionArn)
      // "arn:aws:lambda:...:function:SloganGenerator" -> this stack's slogan ARN
      .replace(/arn:aws:lambda:[^"]*:function:SloganGenerator/g, () => sloganLambda.functionArn);

    const contactFlow = new connect.CfnContactFlow(this, "VanityNumberFlow", {
      instanceArn: connectInstanceArn.valueAsString,
      name: "Vanity Number Flow",
      type: "CONTACT_FLOW",
      description: "Reads caller's vanity numbers (VanityNumberConverter) and offers a slogan (SloganGenerator).",
      content: flowContent,
    });
    contactFlow.cfnOptions.condition = connectArnProvided;
    // Ensure Connect can invoke both Lambdas before the flow references them.
    contactFlow.addDependency(connectPermission);
    contactFlow.addDependency(sloganConnectPermission);

    // ── Stack outputs ─────────────────────────────────────────────────────────
    const flowArnOutput = new cdk.CfnOutput(this, "ContactFlowArn", {
      value: contactFlow.attrContactFlowArn,
      description: "ARN of the created Vanity Number contact flow",
    });
    flowArnOutput.condition = connectArnProvided;

    new cdk.CfnOutput(this, "DashboardURL", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Vanity Number Dashboard URL",
    });

    new cdk.CfnOutput(this, "ConverterLambdaArn", {
      value: converterLambda.functionArn,
      description:
        "VanityNumberConverter Lambda ARN — paste into Amazon Connect > Contact flows > AWS Lambda",
    });

    new cdk.CfnOutput(this, "ConverterLambdaName", {
      value: converterLambda.functionName,
      description: "VanityNumberConverter Lambda function name",
    });

    new cdk.CfnOutput(this, "SloganLambdaArn", {
      value: sloganLambda.functionArn,
      description: "SloganGenerator Lambda ARN — invoked by the contact flow on press-0",
    });

    new cdk.CfnOutput(this, "ApiKeySecretName", {
      value: apiKeySecret.secretName,
      description:
        "Secrets Manager secret for the Anthropic API key — replace its placeholder value with a real key",
    });

    new cdk.CfnOutput(this, "DynamoDBTableName", {
      value: table.tableName,
      description: "DynamoDB table name",
    });

    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: api.apiEndpoint + "/callers",
      description: "Direct API Gateway endpoint (testing only — dashboard uses the CloudFront path)",
    });
  }
}
