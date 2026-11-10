import { streamText, isStepCount, type ModelMessage, type SystemModelMessage } from 'ai';
import { config } from '../config.ts';
import { coolDown, type ModelSlot } from '../llm.ts';
import type { createSearchTool } from '../search/tool.ts';
import type { TurnTrace } from '../memory/store.ts';
import { describeError } from './errors.ts';

/**
 * The agent loop: stream a model with the web_search tool until it answers,
 * surviving rate limits and outages.
 *
 *  - Models go in `chain` order (recently failed ones last; see llm.ts).
 *  - On a retryable failure, the next model takes over. It is handed the search
 *    results gathered so far as plain text, so it continues instead of starting
 *    over. (Raw tool-call messages aren't passed: Gemini 3 signs its own tool
 *    calls and may reject another model's.)
 *  - If every model fails once, pause briefly and go round once more.
 *  - Partial text from a failed attempt is rolled back to the last completed step.
 */

export type SearchTool = ReturnType<typeof createSearchTool>;

export interface AnswerOptions {
  chain: ModelSlot[];
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
  search: SearchTool;
  signal: AbortSignal;
  started: number; // epoch ms the turn began
  softDeadline: number; // epoch ms after which no more searching
  trace: TurnTrace;
  onDelta: (text: string) => void;
  onReset: (keep: string, note: string) => void; // UI: replace the answer so far with `keep`
}

export interface AnswerResult {
  text: string;
  failure: string | null; // user-facing message if no complete answer was produced
}

/** Answer text so far; `doneText` is the part from completed steps, which survives a retry. */
interface Progress {
  text: string;
  doneText: string;
}

const SECOND_PASS_PAUSE_MS = 4_000;

export async function answerWithFallback(o: AnswerOptions): Promise<AnswerResult> {
  const { chain, signal, trace } = o;
  const maxAttempts = chain.length * 2;
  const progress: Progress = { text: '', doneText: '' };
  let failure: string | null = null;

  for (let attempt = 0; attempt < maxAttempts && !signal.aborted; attempt++) {
    const slot = chain[attempt % chain.length]!;

    if (attempt === chain.length) {
      // Bounded by the hard limit, not the search deadline: by now the searches are
      // usually done and handed over, so a retry mostly just writes the answer.
      if (Date.now() + SECOND_PASS_PAUSE_MS > o.started + config.hardDeadlineMs - 30_000) break;
      trace.limits.push(`every model failed once; paused ${SECOND_PASS_PAUSE_MS / 1000}s and tried again`);
      o.onReset(progress.doneText, `The model provider is busy. Trying again in ${SECOND_PASS_PAUSE_MS / 1000} s…`);
      try {
        await sleep(SECOND_PASS_PAUSE_MS, signal);
      } catch {
        break;
      }
    }

    const done = o.search.transcript();
    const continued: ModelMessage[] = done.length
      ? [
          { role: 'assistant', content: `I already ran these web searches for this question:\n\n${done.join('\n\n')}` },
          { role: 'user', content: 'Continue from those results. Search again only for what is still missing, then answer my question.' },
        ]
      : [];

    try {
      // With a backup model, fail over at once instead of waiting out a rate limit
      // (the SDK honours retry-after, which on Gemini's free tier can be 10–40 s).
      const maxRetries = attempt === maxAttempts - 1 ? 2 : chain.length > 1 ? 0 : 1;
      const run = { o, slot, progress, maxRetries };
      const first = await streamOnce({ ...run, messages: [...o.messages, ...continued], forceAnswer: false });
      // Some models end on a tool step without writing an answer. Ask once more, tools off.
      if (!progress.text.trim() && !signal.aborted) {
        trace.limits.push('model ended without an answer; asked again with tools off');
        await streamOnce({ ...run, messages: [...o.messages, ...continued, ...first.response], forceAnswer: true });
      }
      trace.model = slot.id;
      failure = !progress.text.trim() && !signal.aborted ? 'The model returned an empty answer. Please try again.' : null;
      break;
    } catch (err) {
      if (signal.aborted) break;
      progress.text = progress.doneText;
      const reason = describeError(err);
      if (reason.cooldownMs) coolDown(slot.id, reason.cooldownMs);
      failure = reason.message;
      console.warn(`[turn] ${slot.id} ${reason.short}${reason.retryable ? '' : ` (${(err as Error).message})`}`);
      if (!reason.retryable || attempt + 1 >= maxAttempts) break;
      const next = chain[(attempt + 1) % chain.length]!;
      trace.fallbacks.push({ from: slot.id, to: next.id, reason: reason.short });
      if (attempt + 1 !== chain.length) o.onReset(progress.doneText, `${slot.id} ${reason.short}; continuing with ${next.id}.`);
    }
  }
  return { text: progress.text, failure };
}

/** One streamText call (possibly several steps), feeding text and step stats into `progress` and the trace. */
async function streamOnce(a: {
  o: AnswerOptions;
  slot: ModelSlot;
  progress: Progress;
  maxRetries: number;
  messages: ModelMessage[];
  forceAnswer: boolean; // tools stay defined (history may contain tool calls) but can't be called
}): Promise<{ response: ModelMessage[] }> {
  const { o, slot, progress } = a;
  const { trace } = o;
  const result = streamText({
    model: slot.model,
    instructions: o.instructions,
    messages: a.messages,
    tools: { web_search: o.search.tool },
    providerOptions: slot.options as never,
    ...(a.forceAnswer
      ? { toolChoice: 'none' as const }
      : {
          stopWhen: isStepCount(config.maxSteps),
          prepareStep: ({ stepNumber }: { stepNumber: number }) => {
            // Final step, or out of time: tools off, so the turn always ends in an answer.
            if (stepNumber >= config.maxSteps - 1) {
              trace.limits.push(`step limit (${config.maxSteps}) reached: forced final answer`);
              return { toolChoice: 'none' as const };
            }
            if (stepNumber > 0 && Date.now() > o.softDeadline) {
              trace.limits.push(`soft deadline (${config.softDeadlineMs / 1000}s) reached: forced final answer`);
              return { toolChoice: 'none' as const };
            }
            return {};
          },
        }),
    maxRetries: a.maxRetries,
    abortSignal: o.signal,
    // Errors arrive as 'error' parts below and are handled by answerWithFallback, which
    // rolls back to the last completed step and continues with the searches already done.
    onError: () => {},
  });

  let needsBreak = false;
  let stepStart = Date.now();
  let toolCalls = 0;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'start-step':
        stepStart = Date.now();
        toolCalls = 0;
        needsBreak = progress.text.length > 0 && !progress.text.endsWith('\n\n');
        break;
      case 'text-delta': {
        let t = part.text;
        // Text from two steps would otherwise run together ("…searching.Neon costs…").
        if (needsBreak && t.trim()) {
          t = (progress.text.endsWith('\n') ? '\n' : '\n\n') + t;
          needsBreak = false;
        }
        progress.text += t;
        o.onDelta(t);
        break;
      }
      case 'tool-call':
        toolCalls++;
        break;
      case 'finish-step':
        progress.doneText = progress.text;
        trace.steps.push({
          model: part.response?.modelId || slot.id,
          ms: Date.now() - stepStart,
          inputTokens: part.usage.inputTokens,
          cachedInputTokens: part.usage.inputTokenDetails?.cacheReadTokens,
          outputTokens: part.usage.outputTokens,
          reasoningTokens: part.usage.outputTokenDetails?.reasoningTokens,
          toolCalls,
          finishReason: part.finishReason,
        });
        break;
      case 'error':
        throw part.error;
    }
  }
  let response: ModelMessage[] = [];
  if (!o.signal.aborted && !progress.text.trim()) {
    response = await Promise.resolve(result.response).then((r) => r.messages, () => []);
  }
  return { response };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}
