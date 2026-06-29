# vanity-cdk

AWS CDK app for the Vanity Number Solution.

| Resource | Source |
| --- | --- |
| `VanityNumberConverter` Lambda | [`../vanity-lambda`](../vanity-lambda) (`index.mjs` + `vanity-generator.mjs` + `words.mjs`) |
| `VanityDashboardReader` Lambda | [`../vanity-dashboard-reader`](../vanity-dashboard-reader) (`index.mjs`) |
| Dashboard site | [`../vanity-dashboard/index.html`](../vanity-dashboard) |
| Contact flow | [`Vanity Number Flow.json`](Vanity%20Number%20Flow.json) |

## What it provisions

- **DynamoDB** `VanityNumbers` table (`CallerId` partition key, pay-per-request, retained on destroy).
- **Two Lambdas** (Node 20). The source is plain ESM (`.mjs`) whose only runtime dependency is
  `@aws-sdk/*` — already provided by the Node 20 runtime — so the files ship as-is via
  `Code.fromAsset` with no bundling step (`node_modules`, `tests`, `*.zip`, and `package-lock.json`
  are excluded from the package).
- **HTTP API Gateway** exposing `GET /callers` → reader Lambda.
- **S3 + CloudFront** hosting the dashboard, with an **S3 Origin Access Control**.
- The dashboard's `API_URL` is rewritten at synth time to the CloudFront `/callers` path
  (same-origin, so no CORS), and uploaded to S3 with a cache invalidation.
- A conditional `lambda:InvokeFunction` permission for Amazon Connect (set the
  `ConnectInstanceArn` parameter, or add it manually later).
- **Amazon Connect contact flow** (`Vanity Number Flow`), imported from the JSON export in
  this folder. The export's hard-coded Lambda ARN is replaced at synth time with this
  stack's `VanityNumberConverter` ARN. Created only when `ConnectInstanceArn` is supplied
  (same condition as the invoke permission).

## Amazon Connect prerequisites & manual steps

The stack does **not** create the Connect *instance* (that's an account-level resource you
create once). To wire everything up:

1. Create/locate your Amazon Connect instance and copy its ARN
   (`arn:aws:connect:REGION:ACCOUNT:instance/INSTANCE_ID`).
2. Deploy with that ARN (see below). This creates the invoke permission **and** the contact flow.
3. In the Connect console, **claim a phone number** and set its inbound contact flow to
   **Vanity Number Flow**. (CDK can't claim numbers or bind them to a flow — that's manual.)
4. Call the number to test.

If you deploy **without** `ConnectInstanceArn`, neither the permission nor the flow is created;
you can import [`Vanity Number Flow.json`](Vanity%20Number%20Flow.json) manually in the
Connect console and paste the `ConverterLambdaArn` output into its Invoke-Lambda block.

## Usage

```bash
npm install
npm run build            # tsc type-check
npx cdk synth            # synthesize the CloudFormation template
npx cdk deploy --parameters ConnectInstanceArn=arn:aws:connect:us-east-1:...:instance/...
```

After deploy, the stack outputs the dashboard URL, the converter Lambda ARN, the contact flow
ARN (when an instance ARN was supplied), the table name, and the direct API endpoint.
