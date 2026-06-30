/**
 * index.mjs — SloganGenerator Lambda
 * ─────────────────────────────────────────────────────────────────────────────
 * Invoked mid-Contact-Flow after the caller presses 0 to request a marketing
 * slogan for their vanity number. Calls the Anthropic API (Claude Haiku) to
 * generate a short, TTS-friendly slogan and returns it to Connect.
 *
 * TRIGGER: Amazon Connect Contact Flow (Invoke AWS Lambda function block)
 *   Invoked AFTER the VanityNumberConverter Lambda and AFTER the caller has
 *   pressed 0 in the "Get customer input" DTMF block.
 *
 * EXPECTED INPUT (from Connect contact attributes):
 *   The Contact Flow must pass the top vanity number as a parameter.
 *   event.Details.Parameters.vanityNumber — e.g. "1-800-FLOWERS"
 *
 * MODEL CHOICE:
 *   Claude Haiku 4.5 — cheapest, fastest tier. A one-sentence slogan does not
 *   need a frontier model; Haiku produces excellent short-form copy at a
 *   fraction of the cost and latency of Sonnet or Opus. Critical for a live
 *   phone call where every second of Lambda runtime is caller hold time.
 *
 * CONNECT RESPONSE CONTRACT:
 *   {
 *     status: "success",
 *     slogan: "One call connects you to care."
 *   }
 *   On any failure, returns status: "error" with a safe fallback slogan so
 *   the call never goes silent.
 *
 * ENVIRONMENT VARIABLES:
 *   SECRET_NAME - Secrets Manager secret name holding the Anthropic API key
 *                 (vanity-generator/anthropic-api-key)
 *
 * IAM ROLE NEEDS:
 *   - secretsmanager:GetSecretValue on the specific secret ARN
 *   - logs:* for CloudWatch
 *
 * SECRET SHAPE:
 *   Stored as a key/value pair in Secrets Manager:
 *     { "ANTHROPIC_API_KEY": "sk-ant-..." }
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const SECRET_NAME = process.env.SECRET_NAME;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";

// ─── Secrets Manager client ────────────────────────────────────────────────────
// Initialized outside the handler so it's reused across warm invocations.
const secretsClient = new SecretsManagerClient({});

// In-memory cache for the API key across warm Lambda invocations.
// Avoids calling Secrets Manager on every single call — only fetches once
// per container lifecycle, which significantly reduces both latency and
// Secrets Manager API costs at volume.
let cachedApiKey = null;

// ─── Fallback slogans ───────────────────────────────────────────────────────────
// Used if the Anthropic API call fails for any reason. Keeps the call
// experience graceful rather than silent or erroring out.
const FALLBACK_SLOGANS = [
  "A number worth remembering.",
  "Easy to dial. Easy to recall.",
  "Your new number, made memorable.",
];

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  if (!SECRET_NAME) {
    console.error("FATAL: SECRET_NAME environment variable is not set.");
    return errorResponse();
  }

  // ── Extract the vanity number from Connect parameters ──
  const vanityNumber = event?.Details?.Parameters?.vanityNumber;

  if (!vanityNumber) {
    console.error("Missing vanityNumber parameter from Connect event.");
    return errorResponse();
  }

  console.log("Generating slogan for:", vanityNumber);

  // ── Retrieve the API key (cached after first invocation) ──
  let apiKey;
  try {
    apiKey = await getApiKey();
  } catch (err) {
    console.error("Failed to retrieve API key:", err.message);
    return errorResponse();
  }

  // ── Call the Anthropic API ──
  let slogan;
  try {
    slogan = await generateSlogan(vanityNumber, apiKey);
    console.log("Generated slogan:", slogan);
  } catch (err) {
    console.error("Anthropic API call failed:", err.message);
    return errorResponse();
  }

  return {
    status: "success",
    slogan,
  };
};

// ─── Secrets Manager retrieval ──────────────────────────────────────────────────

/**
 * Retrieves the Anthropic API key from Secrets Manager, caching it in memory
 * for the lifetime of the Lambda execution environment. This means the first
 * invocation of a fresh container pays the Secrets Manager latency cost, but
 * every subsequent invocation on a warm container is instant.
 *
 * @returns {Promise<string>} The Anthropic API key
 */
async function getApiKey() {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const result = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: SECRET_NAME })
  );

  const parsed = JSON.parse(result.SecretString);
  const apiKey = parsed.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY key not found in secret value.");
  }

  cachedApiKey = apiKey;
  return apiKey;
}

// ─── Anthropic API call ──────────────────────────────────────────────────────────

/**
 * Calls the Anthropic Messages API to generate a one-sentence marketing
 * slogan for the given vanity number.
 *
 * Uses Claude Haiku for cost and latency — this is a live phone call, so
 * every millisecond of Lambda execution is hold time for the caller. Haiku
 * 4.5 generates short-form creative copy at a fraction of Sonnet/Opus cost
 * and typically responds in under a second.
 *
 * @param {string} vanityNumber - e.g. "1-800-FLOWERS"
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<string>} A short, TTS-safe slogan
 */
async function generateSlogan(vanityNumber, apiKey) {
  const prompt =
    `Write exactly one short marketing slogan (10 words or fewer) for the ` +
    `vanity phone number "${vanityNumber}". The slogan should be punchy, ` +
    `memorable, and suitable for a business to use in advertising. ` +
    `Respond with ONLY the slogan text — no quotes, no preamble, no ` +
    `explanation, no markdown formatting.`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 60,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API returned ${response.status}: ${errorBody}`);
  }

  const data = await response.json();

  // Extract the text content block from the response
  const textBlock = data.content?.find((block) => block.type === "text");

  if (!textBlock?.text) {
    throw new Error("No text content in Anthropic API response.");
  }

  // Clean up — strip any stray quotes or markdown the model might add
  // despite instructions, and trim whitespace.
  const cleaned = textBlock.text
    .trim()
    .replace(/^["']|["']$/g, "") // strip leading/trailing quotes
    .replace(/\*\*/g, "");       // strip stray bold markdown

  return cleaned;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a safe fallback response when slogan generation fails for any
 * reason. Picks a random pre-written fallback so repeated failures (e.g.
 * during an Anthropic outage) don't always return the identical phrase.
 *
 * Status is still "success" with a fallback slogan rather than "error" —
 * the caller experience should never go silent just because the AI call
 * failed. The Contact Flow doesn't need a separate error branch for this
 * Lambda; it can always read whatever slogan comes back.
 */
function errorResponse() {
  const fallback =
    FALLBACK_SLOGANS[Math.floor(Math.random() * FALLBACK_SLOGANS.length)];
  console.warn("Returning fallback slogan:", fallback);
  return {
    status: "success",
    slogan: fallback,
  };
}
