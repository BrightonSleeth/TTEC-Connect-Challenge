# vanity-cdk

AWS CDK app for the Vanity Number Solution.

| Resource | Source |
| --- | --- |
| `VanityNumberConverter` Lambda | [`../vanity-lambda`](../vanity-lambda) (`index.mjs` + `vanity-generator.mjs` + `words.mjs`) |
| `VanityDashboardReader` Lambda | [`../vanity-dashboard-reader`](../vanity-dashboard-reader) (`index.mjs`) |
| `SloganGenerator` Lambda | [`../vanity-slogan-generator`](../vanity-slogan-generator) (`index.mjs`) |
| Dashboard site | [`../vanity-dashboard/index.html`](../vanity-dashboard) |
| Contact flow | [`Vanity Number Flow.json`](Vanity%20Number%20Flow.json) |

## What it provisions

- **DynamoDB** `VanityNumbers` table (`CallerId` partition key, pay-per-request, retained on destroy),
  plus a `LastCalledIndex` GSI (constant `GSIPartition="ALL"` + `LastCalled`) the dashboard queries.
- **Three Lambdas** (Node 24): `VanityNumberConverter`, `VanityDashboardReader`, and `SloganGenerator`.
  The source is plain ESM (`.mjs`) whose only runtime dependency is `@aws-sdk/*` — already provided by
  the Node 24 runtime — so the files ship as-is via `Code.fromAsset` with no bundling step
  (`node_modules`, `tests`, `*.zip`, and `package-lock.json` are excluded from the package).
- **Secrets Manager** secret `vanity-generator/anthropic-api-key` for the slogan Lambda's Anthropic
  API key. Created with a generated **placeholder** so `cdk deploy` is self-contained; the slogan
  Lambda is granted read on it only. **Replace the placeholder with a real key after deploy** (see below).
- **HTTP API Gateway** exposing `GET /callers` → reader Lambda.
- **S3 + CloudFront** hosting the dashboard, with an **S3 Origin Access Control**.
- The dashboard's `API_URL` is rewritten at synth time to the CloudFront `/callers` path
  (same-origin, so no CORS), and uploaded to S3 with a cache invalidation.
- Conditional `lambda:InvokeFunction` permissions for Amazon Connect on **both** the converter and
  slogan Lambdas (set the `ConnectInstanceArn` parameter, or add them manually later).
- **Amazon Connect contact flow** (`Vanity Number Flow`), imported from the JSON export in
  this folder. Both hard-coded Lambda ARNs in the export (`VanityNumberConverter` and
  `SloganGenerator`) are replaced at synth time with this stack's ARNs. Created only when
  `ConnectInstanceArn` is supplied (same condition as the invoke permissions).

## Setting the Anthropic API key

The slogan Lambda reads `{ "ANTHROPIC_API_KEY": "..." }` from the secret. After deploy, replace
the generated placeholder with your real key:

```bash
aws secretsmanager put-secret-value \
  --secret-id vanity-generator/anthropic-api-key \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-..."}'
```

Until you do, the slogan feature still works — the Lambda returns a canned fallback slogan rather
than failing the call.

## Amazon Connect prerequisites & manual steps

The stack does **not** create the Connect *instance* (that's an account-level resource you
create once). To wire everything up:

1. Create/locate your Amazon Connect instance and copy its ARN
   (`arn:aws:connect:REGION:ACCOUNT:instance/INSTANCE_ID`).
2. Deploy with that ARN (see below). This creates the invoke permission **and** the contact flow.
3. In the Connect console, **claim a phone number** and set its inbound contact flow to
   **Vanity Number Flow**. (CDK can't claim numbers or bind them to a flow — that's manual.)
4. Call the number to test.

If you deploy **without** `ConnectInstanceArn`, neither the permissions nor the flow are created;
you can import [`Vanity Number Flow.json`](Vanity%20Number%20Flow.json) manually in the Connect
console and paste the `ConverterLambdaArn` and `SloganLambdaArn` outputs into its two Invoke-Lambda
blocks.

## Usage

```bash
npm install
npm run build            # tsc type-check
npx cdk synth            # synthesize the CloudFormation template
npx cdk deploy --parameters ConnectInstanceArn=arn:aws:connect:us-east-1:...:instance/...
```

After deploy, the stack outputs the dashboard URL, the converter and slogan Lambda ARNs, the
API-key secret name, the contact flow ARN (when an instance ARN was supplied), the table name,
and the direct API endpoint.
