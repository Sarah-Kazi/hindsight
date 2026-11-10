import type { ModelMessage } from 'ai';
import { config } from '../config.ts';
import { clock } from '../clock.ts';
import { answerChain, byAvailability, type Models } from '../llm.ts';
import { buildInstructions, isRecheck } from './prompt.ts';
import { answerWithFallback } from './answer.ts';
import { buildHistory, citedFirst, publicMessage } from './history.ts';
import { numbersIn, verifyCitations } from './verify.ts';
import { createSearchTool, type SearchEvent } from '../search/tool.ts';
import type { SearchProvider } from '../search/tavily.ts';
import { heuristicDigest, writeDigest } from '../memory/digest.ts';
import type { Recall } from '../memory/recall.ts';
import type { Message, Store, TurnTrace } from '../memory/store.ts';
import { formatRange, isValidTimeZone, localDay } from '../time.ts';

export type TurnEvent =
  | { type: 'meta'; threadId: string; userMessageId: string; title: string }
  | { type: 'memory'; recalled: Array<{ day: string; title: string }>; noRecordFor: string[]; dates: Array<{ phrase: string; resolved: string }> }
  | SearchEvent
  | { type: 'delta'; text: string }
  | { type: 'retry'; message: string; text: string } // replace the answer so far with `text` (a model is being retried)
  | { type: 'done'; message: Message }
  | { type: 'error'; message: string };

export interface TurnInput {
  threadId?: string;
  text: string;
  tz?: string;
  signal: AbortSignal;
  emit: (e: TurnEvent) => void;
  now?: Date; // the eval/seed scripts pass a fixed time
  seeded?: boolean;
}

/**
 * One user turn:
 *   1. pre-flight (no model call): save the message, resolve dates, assemble memory
 *   2. agent loop (answer.ts): stream the model with web_search, falling back
 *      along the model chain on rate limits/outages, within a time budget
 *   3. check citations, save the answer with its sources, search log and trace
 *   4. background: digest the exchange into long-term memory
 */
export class Agent {
  private threadLocks = new Map<string, Promise<unknown>>();
  private digestQueue: Promise<void> = Promise.resolve();
  private digesting = new Set<string>();

  constructor(
    private store: Store,
    private recall: Recall,
    private models: Models | null,
    private search: SearchProvider | null,
  ) {}

  /** Turns in the same thread run one at a time; different threads run concurrently. */
  async turn(input: TurnInput): Promise<Message | null> {
    const key = input.threadId ?? '';
    if (!key) return this.runTurn(input);
    const prev = this.threadLocks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.runTurn(input));
    this.threadLocks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.threadLocks.get(key) === run) this.threadLocks.delete(key);
    }
  }

  /** Resolves when background digests have finished (used by scripts and tests). */
  idle(): Promise<void> {
    return this.digestQueue;
  }

  /** On startup: digest any exchange that missed it (crash, restart, provider outage). */
  catchUpDigests(): number {
    if (!this.models) return 0;
    let n = 0;
    for (const ex of this.store.exchanges()) {
      if (!ex.assistant.digest && ex.assistant.content.trim()) {
        this.enqueueDigest(ex.user, ex.assistant, ex.thread.id);
        n++;
      }
    }
    return n;
  }

  private async runTurn(input: TurnInput): Promise<Message | null> {
    const started = Date.now();
    const userSignal = input.signal;
    const emit = (e: TurnEvent) => {
      try {
        input.emit(e);
      } catch {
        /* client went away; keep going so the answer is still saved */
      }
    };
    const now = input.now ?? clock.now();
    const tz = isValidTimeZone(input.tz) ? input.tz : 'UTC';
    const text = input.text.trim();

    if (!this.models) {
      emit({ type: 'error', message: 'No model API key is configured. Add one to .env (see .env.example) and restart.' });
      return null;
    }

    // ── 1. Pre-flight ──
    let thread = input.threadId ? this.store.getThread(input.threadId) : undefined;
    if (!thread) thread = this.store.createThread(now, heuristicDigest({ content: text } as Message, { content: '' } as Message).title, input.seeded);
    const seeded = input.seeded ? { seeded: true } : {};
    const userMsg = this.store.addMessage({ threadId: thread.id, role: 'user', content: text, createdAt: now.toISOString(), localDay: localDay(now, tz), tz, ...seeded });
    emit({ type: 'meta', threadId: thread.id, userMessageId: userMsg.id, title: thread.title });

    const prior = this.store.threadMessages(thread.id).filter((m) => m.id !== userMsg.id);
    const history = buildHistory(prior, config.historyCharBudget);
    const memory = this.recall.build({ text, now, tz, excludeIds: history.includedAssistantIds });
    emit({
      type: 'memory',
      recalled: memory.recalled.map(({ day, title }) => ({ day, title })),
      noRecordFor: memory.noRecordFor,
      dates: memory.refs.map((r) => ({ phrase: r.phrase, resolved: formatRange(r.primary) })),
    });

    // Time budget: a soft deadline stops searching; a hard one stops the turn.
    const hardTimeout = AbortSignal.timeout(config.hardDeadlineMs);
    const signal = AbortSignal.any([userSignal, hardTimeout]);
    const softDeadline = started + config.softDeadlineMs;

    const knownSources = prior.flatMap((m) => m.sources ?? []);
    const search = createSearchTool({
      provider: this.search,
      depth: config.searchDepth,
      today: localDay(now, tz),
      firstSourceNumber: knownSources.reduce((max, s) => Math.max(max, s.n), 0) + 1,
      knownSources,
      maxSearches: config.maxSearchesPerTurn,
      deadline: softDeadline,
      signal,
      emit,
    });

    // "Has it changed?" about a recalled answer: code writes the search plan (see prompt.ts).
    const recheck = isRecheck(text) && memory.baselines.length ? memory.baselines : undefined;
    const instructions = buildInstructions({ now, tz, refs: memory.refs, memory: memory.block, searchEnabled: Boolean(this.search), recheck });
    const messages: ModelMessage[] = [...history.messages, { role: 'user', content: text }];

    const trace: TurnTrace = {
      model: '',
      fallbacks: [],
      preflightMs: Date.now() - started,
      firstTokenMs: null,
      totalMs: 0,
      dates: memory.refs.map((r) => ({ phrase: r.phrase, resolved: formatRange(r.primary), alternatives: r.alternatives.map(formatRange) })),
      context: String(instructions[1]!.content),
      historyMessages: history.messages.length,
      steps: [],
      limits: recheck ? [`re-check plan written by code for: ${recheck.map((b) => b.items.join(', ') || b.day).join('; ')}`] : [],
    };

    // ── 2. Agent loop ──
    let { text: answer, failure } = await answerWithFallback({
      chain: byAvailability(answerChain(this.models)),
      instructions,
      messages,
      search,
      signal,
      started,
      softDeadline,
      trace,
      onDelta: (t) => {
        trace.firstTokenMs ??= Date.now() - started;
        emit({ type: 'delta', text: t });
      },
      onReset: (keep, note) => emit({ type: 'retry', message: note, text: keep }),
    });
    if (hardTimeout.aborted && !userSignal.aborted) {
      failure = `This took longer than ${config.hardDeadlineMs / 1000} seconds, so I stopped. Anything already written is kept above. Try a narrower question.`;
      trace.limits.push('hard deadline reached');
    }

    // ── 3. Verify, save ──
    // Always saved, even when the answer failed or was stopped: the question is
    // part of the user's history ("what did I ask on Tuesday?") either way.
    const status: Message['status'] = userSignal.aborted ? 'aborted' : failure ? 'error' : 'complete';
    if (failure) emit({ type: 'error', message: failure });

    const turnSources = search.sources();
    const sourceText = new Map<number, string>();
    for (const s of [...knownSources, ...turnSources]) if (s.excerpt) sourceText.set(s.n, s.excerpt);
    // Figures the user or memory already supplied (e.g. "then" prices) aren't expected in this turn's sources.
    const allowed = numbersIn(memory.block + '\n' + history.messages.map((m) => String(m.content)).join('\n'));
    const verification = verifyCitations(answer, sourceText, allowed);

    trace.totalMs = Date.now() - started;
    const assistant = this.store.addMessage({
      threadId: thread.id,
      role: 'assistant',
      content: answer,
      createdAt: (input.now ? new Date(now.getTime() + trace.totalMs) : clock.now()).toISOString(),
      localDay: localDay(now, tz),
      tz,
      status,
      sources: citedFirst(turnSources, answer),
      searches: search.log(),
      recall: { recalled: memory.recalled.map(({ day, title }) => ({ day, title })), noRecordFor: memory.noRecordFor },
      verification,
      trace,
      ...seeded,
    });
    if (status !== 'error') emit({ type: 'done', message: publicMessage(assistant) });

    // ── 4. Background digest ──
    if (answer.trim()) this.enqueueDigest(userMsg, assistant, thread.id);
    return assistant;
  }

  private enqueueDigest(user: Message, assistant: Message, threadId: string): void {
    if (this.digesting.has(assistant.id)) return;
    this.digesting.add(assistant.id);
    const models = this.models!;
    // Sequential queue: background work never competes with live turns for rate limit in bursts.
    this.digestQueue = this.digestQueue.then(async () => {
      let digest = heuristicDigest(user, assistant);
      try {
        digest = await writeDigest(models.fast, user, assistant, models.fastOptions);
      } catch (err) {
        console.warn('[digest] falling back to heuristic digest:', (err as Error).message);
      }
      this.digesting.delete(assistant.id);
      if (!this.store.getMessage(assistant.id)) return; // chat deleted meanwhile
      this.store.updateMessage(assistant.id, { digest });
      // Name the thread after its first exchange.
      const first = this.store.threadMessages(threadId).find((m) => m.role === 'assistant');
      if (first?.id === assistant.id && digest.by === 'llm') this.store.updateThread(threadId, { title: digest.title });
    });
  }
}
