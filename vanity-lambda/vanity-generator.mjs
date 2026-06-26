/**
 * Generates vanity numbers from a raw input number and returns scored candidates.
 *
 * Instead of expanding every keypad letter combination (exponential and
 * mostly junk), we walk the dictionary and try to place each word at every position
 * in the 7-digit local number. A position outside a matched word stays a digit, so
 * the output is always a real word embedded in the number .
 * (e.g. "356WERS" is not allowed, but "FLOWERS" is).
 *
 * A word letter matches a digit when either:
 *   - the keypad maps that digit to the letter, or
 *   - the digit is a visual look-alike for the letter, in which
 *     case the digit is kept in place (e.g. "BURG3RS"). 
 *     Substitutes score slightly lower than a fully converted word ("BURGERS").
 *
 * Scoring:
 *   1. length of the largest word formed - longer words score higher
 *   2. how many digits were converted into letters and not substituted - more letters converted score higher
 */
import { WORD_SET } from "./words.mjs";

const KEYPAD = {
  "2": ["A", "B", "C"],
  "3": ["D", "E", "F"],
  "4": ["G", "H", "I"],
  "5": ["J", "K", "L"],
  "6": ["M", "N", "O"],
  "7": ["P", "Q", "R", "S"],
  "8": ["T", "U", "V"],
  "9": ["W", "X", "Y", "Z"],
};

//number substitutes - these will stand in for their letter look-alike.
//results with number substitutes are scored slightly lower than a fully converted word.
//list is kept to highly recognizable substitutes for best results.
//set to empty to disable number substitutes entirely.
const SUBSTITUTE = {
  "0": ["O"],
  "1": ["I"],
  "3": ["E"],
  "5": ["S"],
  "7": ["T"],
};

//weights for scoring
const WORD_WEIGHT = 100; //a full converted word
const LETTER_VALUE = 5; //a digit converted to a letter
const SUBSTITUTE_VALUE = 1; //a digit kept as a look-alike substitute

const GENERATE_AMOUNT = 5; //how many vanities to try and generate by default

export function generateVanities(rawNumber) {
  const number = parsePhoneNumber(rawNumber);
  const local = number.localNumber; //always 7 digits for NANP
  const len = local.length;

  //dedupe by the current vanity string, keeping the highest-scoring variant.
  const best = new Map();

  const consider = (candidate) => {
    const existing = best.get(candidate.vanityNum);
    if (!existing || candidate.score > existing.score) {
      best.set(candidate.vanityNum, candidate);
    }
  };

  //offer the raw number as a fallback.
  consider({
    vanityNum: local,
    formatted: formatFull(number, local),
    word: null,
    score: 0,
  });

  for (const word of WORD_SET) {
    const wlen = word.length;
    if (wlen > len) continue;

    const upper = word.toUpperCase();
    for (let start = 0; start + wlen <= len; start++) {
      const digits = local.slice(start, start + wlen);
      const renderings = renderWordAt(upper, digits);

      for (const r of renderings) {
        const vanityNum = local.slice(0, start) + r.display + local.slice(start + wlen);
        consider({
          vanityNum,
          formatted: formatFull(number, vanityNum),
          word,
          //scores by word length first, then coverage second.
          //this favors a longer word with fewer substitutes over a shorter word with more substitutes.
          score: wlen * WORD_WEIGHT + r.coverage,
        });
      }
    }
  }

  //return the candidates sorted by highest score.
  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, GENERATE_AMOUNT);
}


//attempts to map a word to an equal length digit window in the local number, returning all valid renders.
function renderWordAt(word, digits) {
  const perPosition = [];

  for (let i = 0; i < word.length; i++) {
    const letter = word[i];
    const digit = digits[i];
    const options = [];

    if (KEYPAD[digit] && KEYPAD[digit].includes(letter)) {
      options.push({ ch: letter, value: LETTER_VALUE }); //converted to a letter
    }
    if (SUBSTITUTE[digit] && SUBSTITUTE[digit].includes(letter)) {
      options.push({ ch: digit, value: SUBSTITUTE_VALUE }); //kept as a look-alike
    }

    if (options.length === 0) return []; //word can't be placed at this offset
    perPosition.push(options);
  }

  //build words from the per-position options, keeping track of how many letters were converted.
  let renderings = [{ display: "", coverage: 0 }];
  for (const options of perPosition) {
    const next = [];
    for (const partial of renderings) {
      for (const opt of options) {
        next.push({
          display: partial.display + opt.ch,
          coverage: partial.coverage + opt.value,
        });
      }
    }
    renderings = next;
  }
  return renderings;
}

//formats a vanity number for display
function formatFull(number, localRendering) {
  return `${number.countryCode}-${number.areaCode}-${localRendering}`;
}

//parses a raw phone number into its components, validating it as a 10-digit NANP number. 
function parsePhoneNumber(raw) {
  if (typeof raw !== "string") {
    throw new Error("Phone number must be a string.");
  }

  //strip all non-digit characters except leading +
  const cleaned = raw.replace(/[^\d+]/g, "");

  //validate format for NANP
  const match = cleaned.match(/^\+?1?(\d{3})(\d{3})(\d{4})$/);

  if (!match) {
    throw new Error(
      `Invalid phone number format: "${raw}". Expected a 10-digit NANP number.`
    );
  }

  return {
    countryCode: "1",
    areaCode: match[1],
    localNumber: match[2] + match[3],
  };
}
