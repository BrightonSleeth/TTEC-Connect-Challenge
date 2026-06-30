/**
 * Tests for the SloganGenerator Lambda (index.mjs) with Secrets Manager mocked
 * and the global fetch (Anthropic API) stubbed.
 * Run with: node --test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "aws-sdk-client-mock";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

console.log = () => {};
console.error = () => {};
console.warn = () => {};

const smMock = mockClient(SecretsManagerClient);

// The fallback slogans the Lambda falls back to on any failure (mirrors index.mjs).
const FALLBACKS = [
  "A number worth remembering.",
  "Easy to dial. Easy to recall.",
  "Your new number, made memorable.",
];

// index.mjs reads SECRET_NAME at module load and caches the API key in module scope,
// so each test imports a fresh instance via a cache-busting query string.
let importCounter = 0;
const loadHandler = async () =>
  (await import(`../index.mjs?n=${importCounter++}`)).handler;

const connectEvent = (vanityNumber) => ({ Details: { Parameters: { vanityNumber } } });
const SECRET_OK = { SecretString: JSON.stringify({ ANTHROPIC_API_KEY: "sk-test-123" }) };

// builds a stub fetch that returns an Anthropic-shaped success response
const okFetch = (text) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: "text", text }] }),
});

let originalFetch;
before(() => {
  originalFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  smMock.reset();
  smMock.on(GetSecretValueCommand).resolves(SECRET_OK);
  process.env.SECRET_NAME = "test-secret";
  globalThis.fetch = okFetch("A default slogan.");
});

test("happy path returns the Anthropic slogan and calls the API correctly", async () => {
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "One call connects you to care." }] }) };
  };

  const handler = await loadHandler();
  const res = await handler(connectEvent("1-800-FLOWERS"));

  assert.equal(res.status, "success");
  assert.equal(res.slogan, "One call connects you to care.");
  // called Anthropic with the key from Secrets Manager and a model in the body
  assert.match(captured.url, /api\.anthropic\.com/);
  assert.equal(captured.opts.headers["x-api-key"], "sk-test-123");
  assert.match(captured.opts.body, /claude-haiku/);
});

test("strips surrounding quotes and stray markdown from the model output", async () => {
  globalThis.fetch = okFetch('  "**Bold** and quoted."  ');
  const handler = await loadHandler();
  const res = await handler(connectEvent("1-800-FLOWERS"));
  assert.equal(res.slogan, "Bold and quoted.");
});

test("missing SECRET_NAME returns a fallback slogan without hitting Secrets Manager", async () => {
  delete process.env.SECRET_NAME;
  const handler = await loadHandler();
  const res = await handler(connectEvent("1-800-FLOWERS"));
  assert.equal(res.status, "success");
  assert.ok(FALLBACKS.includes(res.slogan), `unexpected slogan: ${res.slogan}`);
  assert.equal(smMock.commandCalls(GetSecretValueCommand).length, 0);
  process.env.SECRET_NAME = "test-secret";
});

test("missing vanityNumber returns a fallback slogan without calling the API", async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return okFetch("x")();
  };
  const handler = await loadHandler();
  const res = await handler({ Details: { Parameters: {} } });
  assert.equal(res.status, "success");
  assert.ok(FALLBACKS.includes(res.slogan));
  assert.equal(fetchCalled, false);
});

test("an Anthropic API error returns a fallback slogan", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "server error" });
  const handler = await loadHandler();
  const res = await handler(connectEvent("1-800-FLOWERS"));
  assert.equal(res.status, "success");
  assert.ok(FALLBACKS.includes(res.slogan), `unexpected slogan: ${res.slogan}`);
});

test("a Secrets Manager failure returns a fallback slogan", async () => {
  smMock.on(GetSecretValueCommand).rejects(new Error("access denied"));
  const handler = await loadHandler();
  const res = await handler(connectEvent("1-800-FLOWERS"));
  assert.equal(res.status, "success");
  assert.ok(FALLBACKS.includes(res.slogan));
});
