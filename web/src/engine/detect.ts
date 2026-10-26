// In-browser detection of sensitive values. Pure functions, no I/O.

import { FIRST_NAMES, LOCATIONS, NOT_NAMES } from "./lexicon";

export type Category =
  | "PERSON"
  | "EMAIL"
  | "PHONE"
  | "AMOUNT"
  | "CARD"
  | "IBAN"
  | "IP"
  | "LOCATION"
  | "URL"
  | "NATIONAL_ID"
  | "CRYPTO"
  | "DATE";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "PERSON", label: "Person names" },
  { id: "EMAIL", label: "Email addresses" },
  { id: "PHONE", label: "Phone numbers" },
  { id: "AMOUNT", label: "Money amounts" },
  { id: "CARD", label: "Payment cards" },
  { id: "IBAN", label: "Bank accounts (IBAN)" },
  { id: "IP", label: "IP addresses" },
  { id: "LOCATION", label: "Places and addresses" },
  { id: "URL", label: "Links" },
  { id: "NATIONAL_ID", label: "ID numbers (US SSN)" },
  { id: "CRYPTO", label: "Crypto wallets" },
  { id: "DATE", label: "Dates" },
];

export const DEFAULT_CATEGORIES: Category[] = CATEGORIES.map((c) => c.id).filter((c) => c !== "DATE");

export type Sensitivity = "low" | "medium" | "high";
export const THRESHOLDS: Record<Sensitivity, number> = { low: 0.8, medium: 0.6, high: 0.45 };

export interface Detection {
  category: Category;
  start: number;
  end: number;
  score: number;
  rule: string;
}

interface Rule {
  category: Category;
  name: string;
  score: number;
  pattern: RegExp;
  /** Optional check on the matched text; return false to drop, or a new score. */
  check?: (match: string, text: string, index: number) => boolean | number;
  group?: number;
}

// ---- validators ----------------------------------------------------------------------------
export function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function ipv4Valid(s: string): boolean {
  return s.split(".").every((p) => Number(p) <= 255 && String(Number(p)) === p);
}

// ---- pattern rules -------------------------------------------------------------------------
const CURRENCY_PREFIX = "(?:US\\$|\\$|USD|€|EUR|£|GBP|KES|GHS|ZAR|R(?=\\d))";
const NUMBER = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?";
const SCALE = "(?:\\s?(?:k|K|m|M|bn|million|billion|thousand))?";
const CURRENCY_WORD = "(?:dollars?|USD|euros?|EUR|pounds?|GBP|cedis?|shillings?)";

const RULES: Rule[] = [
  { category: "EMAIL", name: "email", score: 0.99, pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { category: "URL", name: "url", score: 0.8, pattern: /\b(?:https?:\/\/|www\.)[^\s<>"'()]+[^\s<>"'().,;:!?]/g },
  {
    category: "CARD",
    name: "card",
    score: 0.97,
    pattern: /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g,
    check: (m) => luhn(m),
  },
  { category: "IBAN", name: "iban", score: 0.95, pattern: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, check: (m) => ibanValid(m) },
  { category: "IP", name: "ipv4", score: 0.9, pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, check: (m) => ipv4Valid(m) },
  { category: "IP", name: "ipv6", score: 0.85, pattern: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g },
  { category: "CRYPTO", name: "eth", score: 0.98, pattern: /\b0x[a-fA-F0-9]{40}\b/g },
  { category: "CRYPTO", name: "btc", score: 0.85, pattern: /\b(?:bc1[a-z0-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g },
  { category: "NATIONAL_ID", name: "ssn", score: 0.85, pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    category: "PHONE",
    name: "intl-phone",
    score: 0.75,
    pattern: /(?<![\w+])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g,
  },
  { category: "PHONE", name: "us-phone", score: 0.65, pattern: /(?<!\d)\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g },
  {
    category: "AMOUNT",
    name: "currency-prefix",
    score: 0.9,
    pattern: new RegExp(`(?<![A-Za-z0-9])${CURRENCY_PREFIX}\\s?(?:${NUMBER})${SCALE}(?![\\d,])`, "g"),
  },
  {
    category: "AMOUNT",
    name: "currency-word",
    score: 0.85,
    pattern: new RegExp(`(?<![A-Za-z0-9.,])(?:${NUMBER})${SCALE}\\s?${CURRENCY_WORD}\\b`, "g"),
  },
  {
    category: "LOCATION",
    name: "street-address",
    score: 0.95,
    pattern: /\b\d{1,5}[A-Za-z]?,?\s+(?:[A-Z][a-z]+\s){1,4}(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Close|Crescent|Way|Lane|Drive|Boulevard|Estate)\b/g,
  },
  {
    category: "DATE",
    name: "numeric-date",
    score: 0.75,
    pattern: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g,
  },
  {
    category: "DATE",
    name: "written-date",
    score: 0.75,
    pattern: /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/g,
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LOCATION_RE = new RegExp(
  `\\b(?:${[...LOCATIONS].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})\\b`,
  "g",
);

// ---- names ---------------------------------------------------------------------------------
const TITLE = "(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir|Pastor|Rev)";
const CAP = "[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?";
const TITLED_NAME = new RegExp(`\\b${TITLE}\\.?\\s+(${CAP}(?:\\s+${CAP}){0,2})`, "g");
const CAP_RUN = new RegExp(`\\b${CAP}(?:\\s+${CAP}){1,3}\\b`, "g");
const SINGLE_CAP = new RegExp(`\\b${CAP}\\b`, "g");
const NAME_CUE = /\b(?:name is|named|called|from|to|with|cc|dear|hi|hello|meet|ask|tell|pay|paid|send|sent|by|contact|for|and|thank|thanks)\s*,?\s*$/i;

function isLocationPhrase(phrase: string): boolean {
  return LOCATIONS.some((l) => l.toLowerCase() === phrase.toLowerCase());
}

function detectNames(text: string): Detection[] {
  const found: Detection[] = [];
  for (const m of text.matchAll(TITLED_NAME)) {
    // Keep the title visible ("Dr [PERSON_1]"); redact only the name.
    const nameStart = m.index! + m[0].length - m[1].length;
    found.push({ category: "PERSON", start: nameStart, end: m.index! + m[0].length, score: 0.92, rule: "titled-name" });
  }
  for (const m of text.matchAll(CAP_RUN)) {
    let words = [...m[0].matchAll(/\S+/g)].map((w) => ({ w: w[0], s: m.index! + w.index!, e: m.index! + w.index! + w[0].length }));
    while (words.length && NOT_NAMES.has(words[0].w.toLowerCase())) words.shift();
    while (words.length && NOT_NAMES.has(words[words.length - 1].w.toLowerCase())) words.pop();
    if (words.length < 2) continue;
    if (words.some((w) => NOT_NAMES.has(w.w.toLowerCase()))) continue;
    const phrase = words.map((w) => w.w).join(" ");
    if (isLocationPhrase(phrase)) continue;
    const knownFirst = FIRST_NAMES.has(words[0].w.toLowerCase());
    const cued = NAME_CUE.test(text.slice(Math.max(0, words[0].s - 25), words[0].s));
    const score = knownFirst ? 0.9 : cued ? 0.75 : 0.55;
    found.push({ category: "PERSON", start: words[0].s, end: words[words.length - 1].e, score, rule: "name-run" });
  }
  for (const m of text.matchAll(SINGLE_CAP)) {
    const word = m[0].toLowerCase();
    if (!FIRST_NAMES.has(word) || NOT_NAMES.has(word)) continue;
    const cued = NAME_CUE.test(text.slice(Math.max(0, m.index! - 25), m.index!));
    found.push({ category: "PERSON", start: m.index!, end: m.index! + m[0].length, score: cued ? 0.8 : 0.62, rule: "first-name" });
  }
  return found;
}

// ---- main ----------------------------------------------------------------------------------
export function resolveOverlaps(detections: Detection[]): Detection[] {
  const kept: Detection[] = [];
  const ordered = [...detections].sort((a, b) => b.score - a.score || b.end - b.start - (a.end - a.start) || a.start - b.start);
  for (const d of ordered) {
    if (kept.every((k) => d.end <= k.start || d.start >= k.end)) kept.push(d);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function detect(text: string, categories: Category[] = DEFAULT_CATEGORIES, sensitivity: Sensitivity = "medium"): Detection[] {
  const threshold = THRESHOLDS[sensitivity];
  const want = new Set(categories);
  const all: Detection[] = [];
  for (const rule of RULES) {
    if (!want.has(rule.category)) continue;
    for (const m of text.matchAll(rule.pattern)) {
      let score = rule.score;
      if (rule.check) {
        const verdict = rule.check(m[0], text, m.index!);
        if (verdict === false) continue;
        if (typeof verdict === "number") score = verdict;
      }
      all.push({ category: rule.category, start: m.index!, end: m.index! + m[0].length, score, rule: rule.name });
    }
  }
  if (want.has("LOCATION")) {
    for (const m of text.matchAll(LOCATION_RE)) {
      all.push({ category: "LOCATION", start: m.index!, end: m.index! + m[0].length, score: 0.7, rule: "place" });
    }
  }
  if (want.has("PERSON")) all.push(...detectNames(text));
  return resolveOverlaps(all.filter((d) => d.score >= threshold));
}
