#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { VanityCdkStack } from "../lib/vanity-cdk-stack";

const app = new cdk.App();

new VanityCdkStack(app, "VanityNumberSolution", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description:
    "TTEC Digital AWS Technical Challenge — Vanity Number Solution. " +
    "Builds the VanityNumberConverter + VanityDashboardReader Lambdas directly from " +
    "the repo-root source folders (vanity-lambda, vanity-dashboard-reader, vanity-dashboard) " +
    "and deploys DynamoDB, API Gateway, S3, CloudFront, and the Amazon Connect contact flow.",
});
