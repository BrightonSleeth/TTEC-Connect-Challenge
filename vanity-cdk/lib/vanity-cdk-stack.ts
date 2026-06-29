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
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Repo root, relative to this file (vanity-cdk/lib).
const REPO_ROOT = path.join(__dirname, "..", "..");
const CONVERTER_DIR = path.join(REPO_ROOT, "vanity-lambda");
const READER_DIR = path.join(REPO_ROOT, "vanity-dashboard-reader");
const DASHBOARD_DIR = path.join(REPO_ROOT, "vanity-dashboard");

// The Lambdas are plain ESM (.mjs) whose only runtime dependency is @aws-sdk/*,
// which the Node 20 runtime already provides — so we ship the source as-is with
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

    // ── VanityNumberConverter Lambda ─────────────────────────────────────────
    // Source lives at repo root in vanity-lambda/ as flat ESM modules
    // (index.mjs + vanity-generator.mjs + words.mjs), shipped as-is.
    const converterLambda = new lambda.Function(this, "VanityNumberConverter", {
      functionName: "VanityNumberConverter",
      runtime: lambda.Runtime.NODEJS_20_X,
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
      runtime: lambda.Runtime.NODEJS_20_X,
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
    // Read the template, point API_URL at the CloudFront /callers path, write to
    // a temp dir, then deploy that to S3. Writing to the OS temp dir keeps the
    // source tree clean.
    const htmlTemplate = fs.readFileSync(path.join(DASHBOARD_DIR, "index.html"), "utf-8");
    const htmlWithUrl = htmlTemplate.replace(
      /const API_URL\s*=\s*["'].*?["'];/,
      `const API_URL = "https://${distribution.distributionDomainName}/callers";`
    );

    const processedDir = fs.mkdtempSync(path.join(os.tmpdir(), "vanity-dashboard-"));
    fs.writeFileSync(path.join(processedDir, "index.html"), htmlWithUrl);

    new s3deploy.BucketDeployment(this, "DashboardDeployment", {
      sources: [s3deploy.Source.asset(processedDir)],
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

    // ── Contact flow ──────────────────────────────────────────────────────────
    // Imports "Vanity Number Flow.json" from the repo root. The exported flow has a
    // hard-coded Lambda ARN, so we swap it for THIS stack's converter ARN. Created
    // only when an instance ARN is supplied (same condition as the invoke permission).
    const flowJson = fs.readFileSync(
      path.join(__dirname, "..", "Vanity Number Flow.json"),
      "utf-8"
    );
    const flowContent = flowJson.replace(
      // any "arn:aws:lambda:...:function:VanityNumberConverter" -> this stack's ARN
      /arn:aws:lambda:[^"]*:function:VanityNumberConverter/g,
      () => converterLambda.functionArn
    );

    const contactFlow = new connect.CfnContactFlow(this, "VanityNumberFlow", {
      instanceArn: connectInstanceArn.valueAsString,
      name: "Vanity Number Flow",
      type: "CONTACT_FLOW",
      description: "Reads caller's vanity numbers via the VanityNumberConverter Lambda.",
      content: flowContent,
    });
    contactFlow.cfnOptions.condition = connectArnProvided;
    // Ensure Connect can invoke the Lambda before the flow references it.
    contactFlow.addDependency(connectPermission);

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
