import * as chrono from 'chrono-node';

/**
 * Date handling works on *local calendar days* ("YYYY-MM-DD" in the user's
 * time zone). A conversation "on 3 November" means the user's 3 November,
 * not UTC's. Every stored message records its local day at creation time.
 */

export type Day = string; // YYYY-MM-DD
export interface DayRange { from: Day; to: Day } // inclusive

export interface TemporalRef {
  phrase: string; // as written by the user
  primary: DayRange; // best interpretation
  alternatives: DayRange[]; // other plausible readings, most likely first
  future: boolean;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Building an Intl formatter costs ~0.2 ms; the memory index formats dozens of
// timestamps per turn, so formatters are cached per time zone.
const dayFormats = new Map<string, Intl.DateTimeFormat>();
const timeFormats = new Map<string, Intl.DateTimeFormat>();

export function localDay(instant: Date, tz: string): Day {
  let f = dayFormats.get(tz);
  // en-CA formats as YYYY-MM-DD.
  if (!f) dayFormats.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
  return f.format(instant);
}

export function localTime(instant: Date, tz: string): string {
  let f = timeFormats.get(tz);
  if (!f) timeFormats.set(tz, (f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })));
  return f.format(instant);
}

/**
 * chrono's large regexes are compiled lazily, and V8 recompiles each one to
 * native code after its first use, so the first two parses cost 50–200 ms each.
 * Pay that at startup, not on the user's first message.
 */
export function warmUp(): void {
  const samples = ['hi there', 'Last Tuesday I asked about Postgres', 'on 3 November', 'last week, 2 days ago', 'What changed since Monday?'];
  for (let i = 0; i < 3; i++) for (const s of samples) resolveTemporalRefs(s, new Date(), 'UTC');
}

export function addDays(day: Day, n: number): Day {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function weekdayOf(day: Day): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function daysBetween(a: Day, b: Day): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Monday-start week, as used in most of the world (ISO 8601). */
export function startOfWeek(day: Day): Day {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** "Tue 3 Nov 2026" — unambiguous across locales, includes the weekday on purpose. */
export function formatDay(day: Day): string {
  const d = new Date(`${day}T00:00:00Z`);
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  const rest = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${wd} ${rest}`;
}

export function formatRange(r: DayRange): string {
  return r.from === r.to ? formatDay(r.from) : `${formatDay(r.from)} – ${formatDay(r.to)}`;
}

export function inRange(day: Day, r: DayRange): boolean {
  return day >= r.from && day <= r.to;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): Day => `${y}-${pad(m)}-${pad(d)}`;
const single = (d: Day): DayRange => ({ from: d, to: d });

const SMALL_NUMBERS: Record<string, number> = { a: 1, one: 1, two: 2, couple: 2, 'a couple of': 2, three: 3, few: 3, 'a few': 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 };

/**
 * Phrases that name a *span* of days. chrono returns these as single points
 * ("last week" → exactly 7 days ago), which is wrong for "what did we
 * discuss last week?", so they are handled first.
 */
function rangeRules(today: Day): Array<[RegExp, (m: RegExpMatchArray) => DayRange]> {
  const [y, mo] = today.split('-').map(Number) as [number, number];
  const monthRange = (year: number, month: number): DayRange => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: ymd(year, month, 1), to: ymd(year, month, last) };
  };
  return [
    [/\b(?:last|previous|past)\s+week\b/i, () => {
      const mon = startOfWeek(today);
      return { from: addDays(mon, -7), to: addDays(mon, -1) };
    }],
    [/\b(?:earlier\s+)?this\s+week\b/i, () => ({ from: startOfWeek(today), to: today })],
    [/\b(?:last|previous|past)\s+month\b/i, () => (mo === 1 ? monthRange(y - 1, 12) : monthRange(y, mo - 1))],
    [/\b(?:earlier\s+)?this\s+month\b/i, () => ({ from: ymd(y, mo, 1), to: today })],
    [/\b(?:in\s+the\s+)?(?:last|past)\s+(\d+|a\s+few|few|a\s+couple\s+of|couple|two|three|four|five|six|seven|ten|fourteen|thirty)\s+days\b/i, (m) => {
      const raw = m[1]!.toLowerCase().replace(/\s+/g, ' ');
      const n = /^\d+$/.test(raw) ? Number(raw) : SMALL_NUMBERS[raw] ?? 3;
      return { from: addDays(today, -Math.min(n, 366)), to: today };
    }],
    [/\b(?:recently|the other day|a while (?:ago|back))\b/i, () => ({ from: addDays(today, -14), to: today })],
    [/\b(?:earlier\s+today|this\s+(?:morning|afternoon|evening)|today\s+(?:at|around)\s+\d)/i, () => ({ from: today, to: today })],
  ];
}

/**
 * Resolve every time reference in `text` to concrete local days.
 * Deterministic on purpose: LLMs are unreliable at weekday arithmetic, and
 * "last Tuesday" must not silently become the wrong day.
 */
export function resolveTemporalRefs(text: string, now: Date, tz: string): TemporalRef[] {
  const today = localDay(now, tz);
  const refs: TemporalRef[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) => taken.some(([a, b]) => start < b && end > a);

  for (const [re, toRange] of rangeRules(today)) {
    const global = new RegExp(re.source, 'gi');
    for (const m of text.matchAll(global)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      taken.push([start, end]);
      refs.push({ phrase: m[0], primary: toRange(m), alternatives: [], future: false });
    }
  }

  // chrono interprets the user's wall clock. We encode local time as a UTC
  // instant and tell chrono the zone is UTC, so its output is local days.
  const [h, min] = localTime(now, tz).split(':').map(Number) as [number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const reference = { instant: new Date(Date.UTC(ty, tm - 1, td, h, min)), timezone: 0 };

  for (const r of chrono.parse(text, reference, { forwardDate: false })) {
    const start = r.index;
    const end = r.index + r.text.length;
    if (overlaps(start, end)) continue;
    // Bare "today"/"now"/"tonight" means the present ("is it still correct today?"),
    // not a past conversation. "earlier today" is handled by the range rules.
    if (/^(?:today|now|right now|tonight|currently)$/i.test(r.text.trim())) continue;
    const ref = interpretChrono(r, today);
    if (!ref) continue;
    taken.push([start, end]);
    refs.push(ref);
  }

  return refs.sort((a, b) => text.indexOf(a.phrase) - text.indexOf(b.phrase));
}

function interpretChrono(r: chrono.ParsedResult, today: Day): TemporalRef | null {
  const s = r.start;
  const phrase = r.text;
  const lower = phrase.toLowerCase();
  const wdMatch = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\b/)?.[1];
  const weekdayName = wdMatch ? WEEKDAYS.find((w) => w.startsWith(wdMatch.slice(0, 3))) : undefined;

  // ── Weekday without an explicit date: "Monday", "last Tuesday", "this Friday" ──
  if (s.isCertain('weekday') && !s.isCertain('day') && weekdayName) {
    const target = WEEKDAYS.indexOf(weekdayName);
    const todayWd = weekdayOf(today);
    const back = (todayWd - target + 7) % 7 || 7; // strictly in the past
    const mostRecentPast = addDays(today, -back);
    const inPrevWeek = addDays(startOfWeek(today), -7 + ((target + 6) % 7));
    const inThisWeek = addDays(startOfWeek(today), (target + 6) % 7);

    if (/\bnext\b/.test(lower)) {
      const fwd = (target - todayWd + 7) % 7 || 7;
      return { phrase, primary: single(addDays(today, fwd)), alternatives: [], future: true };
    }
    if (/\bthis\b/.test(lower)) {
      return { phrase, primary: single(inThisWeek), alternatives: [], future: inThisWeek > today };
    }
    const alternatives: DayRange[] = [];
    const saysLast = /\b(?:last|past|previous)\b/.test(lower);
    // "last Tuesday" said on a Wednesday: yesterday, or the Tuesday of last week?
    if (saysLast && inPrevWeek !== mostRecentPast) alternatives.push(single(inPrevWeek));
    // A bare "on Monday" said on a Monday most likely means a week ago, but could mean today.
    // ("last Monday" said on a Monday never means today.)
    if (!saysLast && target === todayWd) alternatives.push(single(today));
    return { phrase, primary: single(mostRecentPast), alternatives, future: false };
  }

  // ── Explicit calendar date: "3 November", "Nov 3", "2026-11-03" ──
  if (s.isCertain('day') && s.isCertain('month')) {
    let year = s.get('year')!;
    const month = s.get('month')!;
    const day = s.get('day')!;
    let d = ymd(year, month, day);
    // No year given and the date is ahead of us: the user means the last one.
    if (!s.isCertain('year') && d > today) {
      year -= 1;
      d = ymd(year, month, day);
    }
    // Fuzzy relative phrases ("a week ago") get ±1 day of slack.
    const fuzzy = /\bago\b/.test(lower) && !/\b(?:yesterday|today)\b/.test(lower);
    const alternatives = fuzzy ? [{ from: addDays(d, -1), to: addDays(d, 1) }] : [];
    return { phrase, primary: single(d), alternatives, future: d > today };
  }

  // ── Whole month: "in October" ──
  if (s.isCertain('month') && !s.isCertain('day')) {
    let year = s.get('year')!;
    const month = s.get('month')!;
    if (!s.isCertain('year') && ymd(year, month, 1) > today) year -= 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const range = { from: ymd(year, month, 1), to: ymd(year, month, last) };
    return { phrase, primary: range, alternatives: [], future: range.from > today };
  }

  // ── Time of day today: "this morning", "earlier today", "tonight" ──
  if (/\b(?:today|morning|afternoon|evening|tonight|earlier)\b/.test(lower)) {
    return { phrase, primary: single(today), alternatives: [], future: false };
  }

  return null;
}
