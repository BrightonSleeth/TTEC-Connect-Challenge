/**
 * Tests for the dashboard-reader Lambda handler (index.mjs) with DynamoDB mocked.
 * Run with: node --test
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

console.log = () => {};
console.error = () => {};

// index.mjs reads VANITY_TABLE at module load, so set it before importing.
process.env.VANITY_TABLE = "reader-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

let handler;
before(async () => {
  ({ handler } = await import("../index.mjs"));
});

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(ScanCommand).resolves({ Items: [] });
});

const body = (res) => JSON.parse(res.body);

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const res = await handler({ requestContext: { http: { method: "OPTIONS" } } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.equal(res.headers["Access-Control-Allow-Methods"], "GET, OPTIONS");
});

test("missing VANITY_TABLE returns 500", async () => {
  delete process.env.VANITY_TABLE;
  const { handler: h } = await import("../index.mjs?case=no-table");
  const res = await h({});
  assert.equal(res.statusCode, 500);
  assert.equal(body(res).error, "Table is null.");
  process.env.VANITY_TABLE = "reader-test";
});

test("empty table returns 200 with no callers", async () => {
  const res = await handler({});
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res).callers, []);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.equal(res.headers["Cache-Control"], "max-age=25");
});

test("projects object-shaped VanityResults into parallel display/score arrays", async () => {
  ddbMock.on(ScanCommand).resolves({
    Items: [
      {
        CallerId: "+18003569377",
        LastCalled: "2026-06-27T10:00:00Z",
        VanityResults: [
          { vanityNum: "FLOWERS", formatted: "1-800-FLOWERS", word: "flowers", score: 735 },
          { vanityNum: "FLOW3RS", formatted: "1-800-FLOW3RS", word: "flowers", score: 731 },
        ],
      },
    ],
  });

  const { callers } = body(await handler({}));
  assert.equal(callers.length, 1);
  assert.equal(callers[0].callerId, "+18003569377");
  assert.equal(callers[0].timestamp, "2026-06-27T10:00:00Z");
  assert.deepEqual(callers[0].vanityResults, ["1-800-FLOWERS", "1-800-FLOW3RS"]);
  assert.deepEqual(callers[0].topScores, [735, 731]);
});

test("uses LastCalled for the timestamp, falling back to CreatedAt for old records", async () => {
  ddbMock.on(ScanCommand).resolves({
    Items: [
      // newer record uses LastCalled (written by the current generator)
      { CallerId: "+1NEW", LastCalled: "2026-06-27T12:00:00Z", VanityResults: [] },
      // legacy record only has CreatedAt
      { CallerId: "+1OLD", CreatedAt: "2026-06-27T09:00:00Z", VanityResults: [] },
    ],
  });

  const { callers } = body(await handler({}));
  assert.deepEqual(callers.map((c) => c.callerId), ["+1NEW", "+1OLD"]);
  assert.equal(callers[0].timestamp, "2026-06-27T12:00:00Z");
  assert.equal(callers[1].timestamp, "2026-06-27T09:00:00Z"); // CreatedAt fallback
});

test("tolerates legacy string results and missing fields", async () => {
  ddbMock.on(ScanCommand).resolves({
    Items: [
      { CallerId: "+1A", CreatedAt: "2026-06-27T10:00:00Z", VanityResults: ["1-800-LEGACY"] },
      { CallerId: "+1B", CreatedAt: "2026-06-26T10:00:00Z" }, // no VanityResults at all
    ],
  });

  const { callers } = body(await handler({}));
  // legacy string -> kept as display, score null
  assert.deepEqual(callers[0].vanityResults, ["1-800-LEGACY"]);
  assert.deepEqual(callers[0].topScores, [null]);
  // missing VanityResults -> empty arrays, no crash
  assert.deepEqual(callers[1].vanityResults, []);
  assert.deepEqual(callers[1].topScores, []);
});

test("sorts by call time descending and dedupes by CallerId", async () => {
  ddbMock.on(ScanCommand).resolves({
    Items: [
      { CallerId: "+1A", LastCalled: "2026-06-25T10:00:00Z", VanityResults: [] }, // older dup
      { CallerId: "+1A", LastCalled: "2026-06-27T10:00:00Z", VanityResults: [] }, // newest A
      { CallerId: "+1B", LastCalled: "2026-06-26T10:00:00Z", VanityResults: [] },
    ],
  });

  const { callers } = body(await handler({}));
  assert.deepEqual(callers.map((c) => c.callerId), ["+1A", "+1B"]);
  assert.equal(callers[0].timestamp, "2026-06-27T10:00:00Z"); // newest A kept
});

test("returns at most 5 callers", async () => {
  const Items = Array.from({ length: 8 }, (_, i) => ({
    CallerId: `+1${i}`,
    LastCalled: `2026-06-${10 + i}T10:00:00Z`,
    VanityResults: [],
  }));
  ddbMock.on(ScanCommand).resolves({ Items });

  const { callers } = body(await handler({}));
  assert.equal(callers.length, 5);
});

test("a failed scan returns 502", async () => {
  ddbMock.on(ScanCommand).rejects(new Error("scan boom"));
  const res = await handler({});
  assert.equal(res.statusCode, 502);
  assert.equal(body(res).error, "Failed to fetch callers from database.");
});
