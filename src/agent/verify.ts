/**
 * Deterministic citation check, run after every answer (no model call, <1 ms).
 *
 * The most damaging failure for a research agent is a wrong figure with a
 * real-looking citation: "$25/month [2]" when source 2 says $30. So for every
 * sentence or table cell that cites [n], each figure in it (prices, percentages,
 * sizes, counts ≥ 10) must appear in the text the model actually received from
 * source n. Figures that came from recalled memory (the "then" values) are allowed.
 *
 * Tuned to avoid false alarms: a missed warning is better than crying wolf on a
 * correct answer. It catches figures the model invented or carried over from its
 * training data while citing a source that doesn't contain them.
 */

/** Matches [3], [1][2] (as two matches) and [14, 19]. Models use all of these. */
const CITE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Citation numbers in a text, in order of appearance. */
export function citedNumbers(text: string): number[] {
  return [...text.matchAll(CITE)].flatMap((m) => m[1]!.split(',').map((n) => Number(n.trim())));
}

export interface Verification {
  checked: number; // figures checked against their sources
  unsupported: Array<{ value: string; cites: number[]; context: string }>;
}

const FIGURE = /(?<![\w.])([$€£¥₹]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%|k\b|K\b|M\b|m\b(?!o)|bn\b|GB\b|TB\b|MB\b)?/g;
const MONTH_AFTER = /^\s*(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

interface Figure {
  raw: string;
  value: number;
  strong: boolean; // has a currency, %, unit or decimals: worth checking even if small
}

function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const [raw, currency, int, dec, unit] = m;
    const after = text.slice((m.index ?? 0) + raw.length);
    if (MONTH_AFTER.test(after)) continue; // "3 Nov" is a date, not a figure
    let value = Number(int!.replace(/,/g, '') + (dec ?? ''));
    if (!Number.isFinite(value)) continue;
    const u = unit?.toLowerCase();
    if (u === 'k') value *= 1_000;
    else if (u === 'm') value *= 1_000_000;
    else if (u === 'bn') value *= 1_000_000_000;
    const strong = Boolean(currency || dec || unit);
    const isYear = !strong && value >= 1900 && value <= 2100;
    if (isYear) continue;
    if (!strong && value < 10) continue; // "5 tools", "3 plans": too common to be meaningful
    out.push({ raw: raw.trim(), value, strong });
  }
  return out;
}

/** All numeric values in a text, normalised (k/M expanded, commas removed). */
export function numbersIn(text: string): Set<number> {
  const set = new Set<number>();
  for (const m of text.matchAll(FIGURE)) {
    const [, , int, dec, unit] = m;
    let v = Number(int!.replace(/,/g, '') + (dec ?? ''));
    if (!Number.isFinite(v)) continue;
    set.add(v);
    const u = unit?.toLowerCase();
    if (u === 'k') set.add(v * 1_000);
    if (u === 'm') set.add(v * 1_000_000);
    if (u === 'bn') set.add(v * 1_000_000_000);
    // "$19.00" in a source supports "$19" in the answer and vice versa.
    if (Number.isInteger(v * 100)) set.add(Math.round(v * 100) / 100);
  }
  // Also every bare digit run, so "v24.11.1" or "Node24" in a source supports
  // "Node.js 24" in the answer. This errs towards fewer false alarms.
  for (const m of text.matchAll(/\d+/g)) set.add(Number(m[0]));
  return set;
}

/** Split an answer into checkable units: table cells, else sentences. */
function units(answer: string): string[] {
  const out: string[] = [];
  const withoutCode = answer.replace(/```[\s\S]*?```/g, ' ');
  for (const line of withoutCode.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('|')) {
      if (/^\|[\s:|-]+\|$/.test(t)) continue; // separator row
      out.push(...t.split('|').map((c) => c.trim()).filter(Boolean));
    } else {
      out.push(...t.split(/(?<=[.!?])\s+(?=[A-Z(*])/));
    }
  }
  return out;
}

export function verifyCitations(answer: string, sourceText: Map<number, string>, allowed: Set<number> = new Set()): Verification {
  const result: Verification = { checked: 0, unsupported: [] };
  const sourceNumbers = new Map<number, Set<number>>();
  const numbersFor = (n: number) => {
    let s = sourceNumbers.get(n);
    if (!s) sourceNumbers.set(n, (s = numbersIn(sourceText.get(n) ?? '')));
    return s;
  };

  for (const unit of units(answer)) {
    const cites = citedNumbers(unit);
    if (!cites.length) continue;
    const known = [...new Set(cites.filter((n) => sourceText.has(n)))];
    if (!known.length) continue; // citations to sources we have no text for: can't judge
    const claimText = unit.replace(CITE, ' ');
    for (const f of figuresIn(claimText)) {
      result.checked++;
      if (allowed.has(f.value)) continue;
      if (known.some((n) => numbersFor(n).has(f.value))) continue;
      const context = claimText.replace(/\s+/g, ' ').replace(/[*_`]/g, '').trim();
      result.unsupported.push({ value: f.raw, cites: known, context: context.length > 160 ? `${context.slice(0, 157)}…` : context });
    }
  }
  return result;
}
