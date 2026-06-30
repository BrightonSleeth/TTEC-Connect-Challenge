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

test("a substitute-formed word scores below a fully keypad-converted word", () => {
  // ROBOT needs 0 -> O substitutes (R0B0T), so its coverage is below the max a
  // 5-letter all-keypad word could score.
  const robot = generateVanities("+18007020836").find((c) => c.word === "robot");
  assert.ok(robot, "expected a 'robot' candidate");
  const allKeypadMax = 5 * 100 + 5 * 5; // wlen*WORD_WEIGHT + every letter via keypad
  assert.ok(
    robot.score < allKeypadMax,
    `robot score ${robot.score} should be below all-keypad max ${allKeypadMax}`
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

test("includes a TTS rendering that separates digits from words", () => {
  const flowers = generateVanities(FLOWERS).find((c) => c.vanityNum === "FLOWERS");
  assert.equal(flowers.tts, "one, eight zero zero, flowers");
});

test("TTS speaks substitute-formed words as the real word, not its digits", () => {
  // R0B0T keeps substitute digits, but should still be read aloud as "robot".
  const robot = generateVanities("+18007020836").find((c) => c.word === "robot");
  assert.ok(robot, "expected a 'robot' candidate");
  assert.match(robot.tts, /\brobot\b/);
});

test("TTS speaks surrounding digit runs one digit at a time", () => {
  // 702-0836 -> R0B0T36: trailing 36 should be read as separate digits after the word.
  const robot = generateVanities("+18007020836").find((c) => c.word === "robot");
  assert.equal(robot.tts, "one, eight zero zero, robot, three six");
});

test("TTS for the raw fallback reads every digit", () => {
  const fallback = generateVanities("+18001111111")[0];
  assert.equal(fallback.tts, "one, eight zero zero, one one one one one one one");
});

test("candidate vanity numbers are unique (deduped)", () => {
  const results = generateVanities(FLOWERS);
  const seen = new Set(results.map((c) => c.vanityNum));
  assert.equal(seen.size, results.length);
});
