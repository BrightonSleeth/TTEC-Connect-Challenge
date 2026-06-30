/**
 * Tests for the generator Lambda handler (index.mjs) with DynamoDB mocked.
 * Run with: node --test
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

console.log = () => {};
console.error = () => {};
console.warn = () => {};

process.env.TABLE_NAME = "vanity-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

let handler;
before(async () => {
  ({ handler } = await import("../index.mjs"));
});

beforeEach(() => {
  ddbMock.reset();
  // sensible defaults: caller not found, writes succeed
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
});

// Builds a minimal Amazon Connect contact-flow event.
function connectEvent(address) {
  return { Details: { ContactData: { CustomerEndpoint: { Address: address } } } };
}

test("missing TABLE_NAME returns an error response", async () => {
  delete process.env.TABLE_NAME;
  const { handler: h } = await import("../index.mjs?case=no-table");
  const res = await h(connectEvent("+18003569377"));
  assert.equal(res.status, "error");
  process.env.TABLE_NAME = "vanity-test";
});

test("missing caller address returns an error without touching the DB", async () => {
  const res = await handler(connectEvent(undefined));
  assert.equal(res.status, "error");
  assert.equal(res.errorReason, "Unable to identify phone number.");
  assert.equal(ddbMock.commandCalls(GetCommand).length, 0);
});

test("new caller: generates, stores a timestamped record, returns top 3", async () => {
  const res = await handler(connectEvent("+18003569377"));

  assert.equal(res.status, "success");
  assert.equal(res.vanity1, "1-800-FLOWERS");
  assert.equal(typeof res.vanity2, "string");
  assert.equal(typeof res.vanity3, "string");
  // tts attributes are exposed for the Connect speech block
  assert.equal(res.vanity1tts, "one, eight zero zero, flowers");
  // first-time caller greeting
  assert.equal(res.greeting, "Your new vanity numbers are:");
  assert.equal(res.isReturning, "false");

  // exactly one write, with the call logged regardless of content
  const puts = ddbMock.commandCalls(PutCommand);
  assert.equal(puts.length, 1);
  const item = puts[0].args[0].input.Item;
  assert.equal(item.CallerId, "+18003569377");
  assert.ok(item.VanityResults.length > 0);
  // each stored result carries a TTS-friendly rendering for the contact flow
  assert.equal(item.VanityResults[0].tts, "one, eight zero zero, flowers");
  assert.match(item.LastCalled, /^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  assert.equal(item.GSIPartition, "ALL"); // groups the record into the LastCalledIndex GSI
  // write is guarded so concurrent callers can't clobber each other
  assert.equal(
    puts[0].args[0].input.ConditionExpression,
    "attribute_not_exists(CallerId)"
  );
});

test("existing caller: returns stored results and refreshes the timestamp", async () => {
  ddbMock.on(GetCommand).resolves({
    Item: {
      CallerId: "+18003569377",
      VanityResults: [
        { formatted: "1-800-FLOWERS", tts: "one, eight zero zero, flowers", score: 735 },
        { formatted: "1-800-FLOW3RS", tts: "one, eight zero zero, flowers", score: 731 },
        { formatted: "1-800-3LOWERS", tts: "one, eight zero zero, three, lowers", score: 630 },
      ],
    },
  });

  const res = await handler(connectEvent("+18003569377"));

  assert.equal(res.status, "success");
  assert.equal(res.vanity1, "1-800-FLOWERS");
  assert.equal(res.vanity2, "1-800-FLOW3RS");
  assert.equal(res.vanity3, "1-800-3LOWERS");
  assert.equal(res.vanity1tts, "one, eight zero zero, flowers");
  // repeat caller greeting
  assert.equal(res.greeting, "Welcome back! Your vanity numbers are:");
  assert.equal(res.isReturning, "true");

  // cache hit with tts present: timestamp refreshed, no new record written
  assert.equal(ddbMock.commandCalls(UpdateCommand).length, 1);
  assert.equal(ddbMock.commandCalls(PutCommand).length, 0);
});

test("existing caller with fewer than 3 results pads with empty strings", async () => {
  ddbMock.on(GetCommand).resolves({
    Item: {
      CallerId: "+18003569377",
      VanityResults: [{ formatted: "1-800-FLOWERS", tts: "one, eight zero zero, flowers" }],
    },
  });
  const res = await handler(connectEvent("+18003569377"));
  assert.equal(res.vanity1, "1-800-FLOWERS");
  assert.equal(res.vanity2, "");
  assert.equal(res.vanity3, "");
  assert.equal(res.vanity3tts, "");
});

test("legacy cached record without tts is regenerated and healed", async () => {
  // stored before the tts field existed -> no tts on the entries
  ddbMock.on(GetCommand).resolves({
    Item: {
      CallerId: "+18003569377",
      VanityResults: [{ formatted: "1-800-FLOWERS", score: 735 }],
    },
  });

  const res = await handler(connectEvent("+18003569377"));

  // tts is backfilled rather than returned empty
  assert.equal(res.vanity1, "1-800-FLOWERS");
  assert.equal(res.vanity1tts, "one, eight zero zero, flowers");

  // the record is healed with a fresh write (not just a timestamp update)
  const puts = ddbMock.commandCalls(PutCommand);
  assert.equal(puts.length, 1);
  assert.ok(puts[0].args[0].input.Item.VanityResults[0].tts);
});

test("generation failure still logs the call, then surfaces an error", async () => {
  // A truthy but unparseable address passes extraction, then throws in generation.
  const res = await handler(connectEvent("+1555"));

  assert.equal(res.status, "error");
  assert.equal(res.errorReason, "Vanity generation failed.");

  // the call is still recorded, with empty results
  const puts = ddbMock.commandCalls(PutCommand);
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].args[0].input.Item.VanityResults, []);
});

test("a failed DynamoDB read is non-fatal: still generates and responds", async () => {
  ddbMock.on(GetCommand).rejects(new Error("dynamo unavailable"));
  const res = await handler(connectEvent("+18003569377"));
  assert.equal(res.status, "success");
  assert.equal(res.vanity1, "1-800-FLOWERS");
  assert.equal(ddbMock.commandCalls(PutCommand).length, 1);
});

test("a failed DynamoDB write is non-fatal: caller still gets results", async () => {
  ddbMock.on(PutCommand).rejects(new Error("write throttled"));
  const res = await handler(connectEvent("+18003569377"));
  assert.equal(res.status, "success");
  assert.equal(res.vanity1, "1-800-FLOWERS");
});
