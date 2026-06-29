import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { VanityCdkStack } from "../lib/vanity-cdk-stack";

// Synthesizes the stack and asserts the core resources exist.
let template: Template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new VanityCdkStack(app, "TestStack");
  template = Template.fromStack(stack);
});

test("creates the VanityNumbers DynamoDB table", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "VanityNumbers",
    KeySchema: [{ AttributeName: "CallerId", KeyType: "HASH" }],
  });
});

test("creates both Lambda functions on Node 20", () => {
  // exact count is left unasserted: BucketDeployment + S3 auto-delete add helper Lambdas.
  template.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "VanityNumberConverter",
    Runtime: "nodejs20.x",
    Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue() }) },
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    FunctionName: "VanityDashboardReader",
    Runtime: "nodejs20.x",
    Environment: { Variables: Match.objectLike({ VANITY_TABLE: Match.anyValue() }) },
  });
});

test("creates a CloudFront distribution with no auth function (removed for demo)", () => {
  template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  template.resourceCountIs("AWS::CloudFront::Function", 0);
});

test("exposes GET /callers on an HTTP API", () => {
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /callers",
  });
});
