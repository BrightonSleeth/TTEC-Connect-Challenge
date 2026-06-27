/**
 * Unit tests for the pure vanity-number generator (no AWS dependencies).
 * Run with: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateVanities } from "../vanity-generator.mjs";

// 1-800-356-9377 spells 1-800-FLOWERS
const FLOWERS = "+18003569377";

test("parses common phone-number formats to the same result", () => {
  const variants = [
    "+18003569377",
    "18003569377",
    "8003569377",
    "(800) 356-9377",
    "1 (800) 356-9377",
  ];
  for (const v of variants) {
    const top = generateVanities(v)[0];
    assert.equal(top.formatted, "1-800-FLOWERS", `failed for input ${v}`);
  }
});

test("throws on an invalid phone number", () => {
  assert.throws(() => generateVanities("12345"), /Invalid phone number/);
  assert.throws(() => generateVanities(""), /Invalid phone number/);
  assert.throws(() => generateVanities(1234567890), /must be a string/);
});

test("finds the full word and ranks it first", () => {
  const results = generateVanities(FLOWERS);
  assert.equal(results[0].vanityNum, "FLOWERS");
  assert.equal(results[0].word, "flowers");
  assert.equal(results[0].formatted, "1-800-FLOWERS");
});

test("every candidate has the expected shape", () => {
  for (const c of generateVanities(FLOWERS)) {
    assert.equal(typeof c.vanityNum, "string");
    assert.equal(typeof c.score, "number");
    assert.match(c.formatted, /^1-800-/);
    // word is a dictionary word or null (the raw fallback)
    assert.ok(c.word === null || typeof c.word === "string");
  }
});

test("results are sorted by score descending and capped", () => {
  const results = generateVanities(FLOWERS);
  assert.ok(results.length <= 5, "should return at most GENERATE_AMOUNT results");
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].score >= results[i].score, "not sorted descending");
  }
});

test("a fully-converted word scores higher than its substitute variant", () => {
  const results = generateVanities(FLOWERS);
  const flowers = results.find((c) => c.vanityNum === "FLOWERS");
  const flow3rs = results.find((c) => c.vanityNum === "FLOW3RS");
  assert.ok(flowers, "expected FLOWERS candidate");
  assert.ok(flow3rs, "expected FLOW3RS substitute candidate");
  assert.ok(
    flowers.score > flow3rs.score,
    `FLOWERS (${flowers.score}) should beat FLOW3RS (${flow3rs.score})`
  );
});

test("longer words outrank shorter words", () => {
  // FLOWERS (7) must outrank any shorter word found in the same number (e.g. FLOW, LOWER).
  const results = generateVanities(FLOWERS);
  const best = results[0];
  const shorter = results.find((c) => c.word && c.word.length < best.word.length);
  if (shorter) {
    assert.ok(best.score > shorter.score, "longer word should score higher");
  }
  assert.equal(best.word, "flowers");
});

test("digit look-alikes let 0/1 positions form words", () => {
  // 702-0836 -> R0B0T6: the two 0s stand in for O (impossible via the keypad alone).
  const results = generateVanities("+18007020836");
  const robot = results.find((c) => c.word === "robot");
  assert.ok(robot, "expected a 'robot' candidate via 0->O substitution");
  assert.ok(robot.vanityNum.startsWith("R0B0T"), `got ${robot.vanityNum}`);
});

test("falls back to the raw number when no word matches", () => {
  // local part 1111111 has no keypad letters and no substitute word.
  const results = generateVanities("+18001111111");
  assert.equal(results.length, 1);
  assert.equal(results[0].word, null);
  assert.equal(results[0].vanityNum, "1111111");
  assert.equal(results[0].score, 0);
  assert.equal(results[0].formatted, "1-800-1111111");
});

test("candidate vanity numbers are unique (deduped)", () => {
  const results = generateVanities(FLOWERS);
  const seen = new Set(results.map((c) => c.vanityNum));
  assert.equal(seen.size, results.length);
});
