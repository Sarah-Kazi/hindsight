import MiniSearch from 'minisearch';
import type { Exchange, SourceRef, Store } from './store.ts';
import { citedNumbers } from '../agent/verify.ts';
import { daysBetween, formatDay, formatRange, inRange, localTime, resolveTemporalRefs, type DayRange, type TemporalRef } from '../time.ts';

/**
 * Memory is assembled by the server before every turn instead of being a tool
 * the model may or may not call:
 *  - the brief allows exactly one tool (web search);
 *  - models under-call "recall" tools, and a missed recall turns into a
 *    hallucinated past conversation, which is the worst failure for this product;
 *  - it costs zero model round-trips (~1 ms of work).
 *
 * Three layers, cheapest first:
 *  1. INDEX: one line per past exchange (date, thread, gist), always included,
 *     so the model can spot vague references ("that database thing").
 *  2. DATE MATCHES: exchanges on the days the user named, in full detail,
 *     or an explicit "no record" so the model can't invent one.
 *  3. TOPIC MATCHES: full-text search (fuzzy, prefix) for the message's
 *     subject, so "Postgres hosting" finds "Supabase vs Neon".
 */

const STOPWORDS = new Set(
  ('a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our ' +
    'so than that the their them then there these they this to was we were what when where which who why will with would you your ' +
    'about any anything ask asked tell told said say since still today now correct changed change last week monday tuesday wednesday ' +
    'thursday friday saturday sunday yesterday ago earlier before again please hey hi thanks').split(' '),
);

const BACKREF =
  /\b(?:(?:i|we)\s+(?:asked|discussed|talked|spoke|said|mentioned|shortlisted|compared|looked\s+at|decided|chose|picked|went\s+through|covered)|you\s+(?:said|told|recommended|suggested|answered|mentioned|gave|listed|found)|earlier|previously|last\s+time|remember|recall|still\s+(?:correct|true|accurate|valid|right)|since\s+then|our\s+(?:conversation|chat|discussion)|your\s+(?:answer|recommendation|list))\b/i;

const INDEX_LIMIT = 40;
const DETAIL_PER_REF = 4;
const ANSWER_EXCERPT_CHARS = 2400;

export interface RecallResult {
  block: string; // goes into the system prompt
  refs: TemporalRef[];
  recalled: Array<{ id: string; day: string; title: string }>; // shown in the UI
  noRecordFor: string[];
  /** For each recalled answer: what it covered, so a re-check can be planned in code. */
  baselines: Baseline[];
}

export interface Baseline {
  day: string; // YYYY-MM-DD the earlier answer was given
  items: string[]; // the products/things it made claims about
  pages: string[]; // the pages it relied on
}

export class Recall {
  private index = new MiniSearch<{ id: string; question: string; answer: string; keywords: string }>({
    fields: ['question', 'answer', 'keywords'],
    processTerm: (term) => {
      const t = term.toLowerCase();
      return t.length < 2 || STOPWORDS.has(t) ? null : t;
    },
    searchOptions: { boost: { keywords: 3, question: 2 }, fuzzy: 0.2, prefix: true, combineWith: 'OR' },
  });

  constructor(private store: Store) {
    for (const ex of store.exchanges()) this.upsert(ex);
    store.onExchange((ex) => this.upsert(ex));
  }

  private upsert(ex: Exchange): void {
    const d = ex.assistant.digest;
    const doc = {
      id: ex.assistant.id,
      question: ex.user.content,
      answer: ex.assistant.content,
      keywords: d ? [ex.thread.title, d.summary, ...d.topics, ...d.entities, ...d.claims.map((c) => `${c.entity} ${c.attribute}`)].join(' ') : ex.thread.title,
    };
    if (this.index.has(doc.id)) this.index.replace(doc);
    else this.index.add(doc);
  }

  build(opts: { text: string; now: Date; tz: string; excludeIds: Set<string> }): RecallResult {
    const { text, now, tz, excludeIds } = opts;
    const refs = resolveTemporalRefs(text, now, tz);
    const all = this.store.exchanges();
    const past = all.filter((e) => !excludeIds.has(e.assistant.id));
    const recalled: RecallResult['recalled'] = [];
    const noRecordFor: string[] = [];
    const baselines: Baseline[] = [];
    const parts: string[] = [];

    if (all.length === 0) {
      const named = refs.filter((r) => !r.future).map((r) => `"${r.phrase}" (${formatRange(r.primary)})`);
      parts.push(
        'You have NO record of any earlier conversation with this user. This is your first conversation.' +
          (named.length ? ` They referred to ${named.join(', ')}; you have nothing from then.` : ''),
      );
      return { block: parts.join('\n'), refs, recalled, noRecordFor: refs.filter((r) => !r.future).map((r) => formatRange(r.primary)), baselines };
    }

    // ── 1. Index ──
    const indexed = past.slice(-INDEX_LIMIT);
    parts.push(
      `<memory_index count="${past.length}"${past.length > INDEX_LIMIT ? ` showing="latest ${INDEX_LIMIT}"` : ''}>`,
      ...indexed.map((e) => `- ${formatDay(e.user.localDay)} ${localTime(new Date(e.user.createdAt), tz)} · "${e.thread.title}" · ${gist(e)}`),
      '</memory_index>',
    );
    if (past.length === 0) parts.push('(Earlier messages from this same chat are already in the conversation above; nothing else is on record.)');

    const detailed = new Set<string>();
    const details: string[] = [];
    const addDetail = (e: Exchange, reason: string) => {
      if (detailed.has(e.assistant.id)) return;
      detailed.add(e.assistant.id);
      recalled.push({ id: e.assistant.id, day: e.user.localDay, title: e.thread.title });
      details.push(renderExchange(e, tz, reason));
      if (e.assistant.content.trim()) baselines.push(baselineOf(e));
    };

    // ── 2. Date matches ──
    const pastRefs = refs.filter((r) => !r.future);
    const daysWithRecords = [...new Set(all.map((e) => e.user.localDay))];
    for (const ref of pastRefs) {
      const candidates = [ref.primary, ...ref.alternatives];
      let matchedRange: DayRange | null = null;
      let matches: Exchange[] = [];
      for (const range of candidates) {
        // Search everything, including this chat: a match that is already in
        // the visible conversation is still a match, not "no record".
        matches = all.filter((e) => inRange(e.user.localDay, range));
        if (matches.length) {
          matchedRange = range;
          break;
        }
      }
      if (!matchedRange) {
        noRecordFor.push(formatRange(ref.primary));
        const nearest = daysWithRecords
          .map((d) => ({ d, dist: Math.abs(daysBetween(ref.primary.from, d)) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 3)
          .map((x) => formatDay(x.d));
        details.push(
          `<no_record phrase="${ref.phrase}" resolved="${candidates.map(formatRange).join(' or ')}">You have NO conversation on record for this. ` +
            `Days that do have conversations, nearest first: ${nearest.join(', ') || 'none'}.</no_record>`,
        );
        continue;
      }
      const inThisChat = matches.filter((e) => excludeIds.has(e.assistant.id)).length;
      if (inThisChat) details.push(`<note>${inThisChat} exchange(s) from ${formatRange(matchedRange)} are in this chat, already visible above.</note>`);
      // Prefer exchanges that are also on-topic when the range has several.
      const ranked = rankByTopic(matches.filter((e) => !excludeIds.has(e.assistant.id)), this.topicScores(text));
      ranked.slice(0, DETAIL_PER_REF).forEach((e) => addDetail(e, `matches "${ref.phrase}" → ${formatRange(matchedRange!)}`));
      if (matchedRange !== ref.primary) {
        details.push(`<note>"${ref.phrase}" most naturally means ${formatRange(ref.primary)}, which has no record; the closest reading with a record is ${formatRange(matchedRange)}. Say which one you used.</note>`);
      }
      if (ranked.length > DETAIL_PER_REF) details.push(`<note>${ranked.length - DETAIL_PER_REF} more conversation(s) in ${formatRange(matchedRange)} are listed in the index only.</note>`);
    }

    // ── 3. Topic matches ──
    const backRef = BACKREF.test(text);
    const scores = this.topicScores(text);
    const hits = [...scores.entries()].filter(([id]) => !excludeIds.has(id)).sort((a, b) => b[1] - a[1]);
    const top = hits[0]?.[1] ?? 0;
    // Without a back-reference only a very strong topic match is worth the tokens.
    const minScore = backRef ? Math.max(2, top * 0.45) : Math.max(8, top * 0.7);
    const limit = backRef ? 3 : 1;
    const byId = new Map(past.map((e) => [e.assistant.id, e]));
    for (const [id, score] of hits.filter(([, s]) => s >= minScore).slice(0, limit)) {
      const e = byId.get(id);
      if (e) addDetail(e, `topic match (score ${score.toFixed(1)})`);
    }

    if (backRef && detailed.size === 0 && noRecordFor.length === 0) {
      details.push('<note>The user seems to refer to an earlier conversation, but nothing on record clearly matches. Check the index above; if nothing fits, say so instead of guessing.</note>');
    }
    if (details.length) parts.push('<recalled>', ...details, '</recalled>');

    return { block: parts.join('\n'), refs, recalled, noRecordFor, baselines };
  }

  private topicScores(text: string): Map<string, number> {
    const q = text.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').trim();
    const scores = new Map<string, number>();
    if (!q) return scores;
    for (const r of this.index.search(q)) scores.set(String(r.id), r.score);
    return scores;
  }
}

function rankByTopic(list: Exchange[], scores: Map<string, number>): Exchange[] {
  return [...list].sort((a, b) => (scores.get(b.assistant.id) ?? 0) - (scores.get(a.assistant.id) ?? 0) || b.user.createdAt.localeCompare(a.user.createdAt));
}

function gist(e: Exchange): string {
  const q = oneLine(e.user.content, 110);
  const d = e.assistant.digest;
  const entities = d?.entities.length ? ` [${d.entities.slice(0, 6).join(', ')}]` : '';
  const failed = e.assistant.content.trim() ? '' : ' (your answer failed)';
  return `asked: "${q}"${entities}${failed}`;
}

/** What an earlier answer covered: items it made claims about, and the pages it used. */
function baselineOf(e: Exchange): Baseline {
  const d = e.assistant.digest;
  const fromClaims = [...new Set(d?.claims.map((c) => c.entity.trim()).filter(Boolean) ?? [])];
  const items = (fromClaims.length ? fromClaims : d?.entities ?? []).slice(0, 8);
  const cited = new Set(citedNumbers(e.assistant.content));
  const pages = (e.assistant.sources ?? []).filter((s) => cited.has(s.n)).map((s) => s.url.replace(/^https?:\/\/(www\.)?/, '')).slice(0, 10);
  return { day: e.user.localDay, items, pages };
}

/**
 * Old answers cite [n] from *their* turn. Shown raw, the model copies those
 * numbers into a new answer where they point at nothing, so they become domains.
 */
function withSourceNames(content: string, sources: SourceRef[] = []): string {
  const byN = new Map(sources.map((s) => [s.n, s.domain]));
  return content.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums: string) => {
    const names = [...new Set(nums.split(',').map((n) => byN.get(Number(n.trim()))).filter(Boolean))];
    return names.length ? `(source: ${names.join(', ')})` : '';
  });
}

function renderExchange(e: Exchange, tz: string, reason: string): string {
  const d = e.assistant.digest;
  const when = `${formatDay(e.user.localDay)} ${localTime(new Date(e.user.createdAt), tz)}`;
  const lines = [
    `<conversation when="${when}" thread="${e.thread.title}" why="${reason}"${e.assistant.status === 'aborted' ? ' note="your answer was cut off"' : ''}>`,
    `User asked: ${e.user.content.trim()}`,
    e.assistant.content.trim()
      ? `You answered: ${excerpt(withSourceNames(e.assistant.content, e.assistant.sources), ANSWER_EXCERPT_CHARS)}`
      : `You answered: nothing. Your answer ${e.assistant.status === 'aborted' ? 'was stopped by the user' : 'failed with an error'} before any text was written. Say so if asked.`,
  ];
  if (d?.claims.length) {
    lines.push(`Facts you stated then (as of ${formatDay(e.user.localDay)}):`);
    for (const c of d.claims) {
      const src = c.source != null ? e.assistant.sources?.find((s) => s.n === c.source) : undefined;
      lines.push(`  - ${c.entity} · ${c.attribute}: ${c.value}${src ? ` (source: ${src.url})` : ''}`);
    }
  }
  if (e.assistant.sources?.length) {
    lines.push(`Sources you used then: ${e.assistant.sources.slice(0, 10).map((s) => s.url).join(' , ')}`);
  }
  lines.push('</conversation>');
  return lines.join('\n');
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function excerpt(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}\n…[answer truncated]` : t;
}
