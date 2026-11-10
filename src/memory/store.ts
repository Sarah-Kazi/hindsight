import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Day } from '../time.ts';

/**
 * Durable state: one JSON file, written atomically.
 *
 * Why not SQLite? `better-sqlite3` is a native add-on, and a failed
 * `npm install` on a reviewer's machine is fatal. One person's chat history is
 * kilobytes to a few MB, so a JSON file plus an in-memory index is both fast
 * enough and impossible to break at install time.
 */

export interface SourceRef {
  n: number; // citation number, unique within a thread
  url: string;
  title: string;
  domain: string;
  published?: string; // publish date reported by the search provider, if any
  retrievedAt: string; // ISO time we fetched it
  excerpt?: string; // the page text the model saw (citation checks, later comparisons)
}

export interface SearchLog {
  query: string;
  mode: 'web' | 'news';
  since?: Day;
  domains?: string[];
  resultCount: number;
  ms: number;
  error?: string;
}

/** A specific, checkable fact the assistant stated. Points back to its answer. */
export interface Claim {
  entity: string; // "Neon"
  attribute: string; // "Launch plan price"
  value: string; // "$19/month"
  source?: number | null; // citation number in that answer
}

export interface Digest {
  title: string;
  summary: string;
  topics: string[];
  entities: string[];
  claims: Claim[];
  by: 'llm' | 'heuristic';
}

export interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string; // ISO UTC
  localDay: Day; // the user's calendar day when it was written
  tz: string;
  status?: 'complete' | 'aborted' | 'error';
  sources?: SourceRef[];
  searches?: SearchLog[];
  digest?: Digest; // on assistant messages: describes the exchange it closes
  recall?: { recalled: Array<{ day: Day; title: string }>; noRecordFor: string[] }; // what memory supplied for this answer
  verification?: { checked: number; unsupported: Array<{ value: string; cites: number[]; context: string }> };
  trace?: TurnTrace;
  seeded?: boolean; // created by `npm run seed`, shown as such in the UI
}

/** Everything needed to explain an answer after the fact (shown in the UI's Inspect panel). */
export interface TurnTrace {
  model: string; // the model that produced the final answer
  fallbacks: Array<{ from: string; to: string; reason: string }>;
  preflightMs: number;
  firstTokenMs: number | null;
  totalMs: number;
  dates: Array<{ phrase: string; resolved: string; alternatives: string[] }>;
  context: string; // the per-turn part of the system prompt: clock, resolved dates, MEMORY
  historyMessages: number; // in-thread messages sent along
  steps: Array<{ model: string; ms: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number; toolCalls: number; finishReason: string }>;
  limits: string[]; // e.g. "soft deadline reached", "forced final answer"
}

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  seeded?: boolean;
}

/** One user question and the answer to it: the unit of long-term memory. */
export interface Exchange {
  user: Message;
  assistant: Message;
  thread: Thread;
}

interface Data {
  version: 1;
  threads: Thread[];
  messages: Message[];
}

type Listener = (exchange: Exchange) => void;

export class Store {
  private data: Data = { version: 1, threads: [], messages: [] };
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private listeners: Listener[] = [];

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'store.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Data;
      if (!Array.isArray(parsed.threads) || !Array.isArray(parsed.messages)) throw new Error('bad shape');
      this.data = parsed;
    } catch (err) {
      // Never lose history silently: keep the broken file next to a fresh one.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, backup);
      console.error(`[store] Could not read ${this.file} (${(err as Error).message}). Backed it up to ${backup} and started fresh.`);
    }
  }

  /** Debounced so a streaming turn doesn't write the file on every update. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 150);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const json = JSON.stringify(this.data);
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, this.file); // atomic replace: a crash never leaves half a file
    } catch {
      // Windows can refuse the rename while another process (e.g. antivirus) holds the file.
      fs.writeFileSync(this.file, json);
    }
  }

  onExchange(fn: Listener): void {
    this.listeners.push(fn);
  }

  // ── Threads ──
  createThread(now: Date, title = 'New chat', seeded = false): Thread {
    const t: Thread = { id: randomUUID(), title, createdAt: now.toISOString(), updatedAt: now.toISOString(), ...(seeded ? { seeded } : {}) };
    this.data.threads.push(t);
    this.scheduleSave();
    return t;
  }

  getThread(id: string): Thread | undefined {
    return this.data.threads.find((t) => t.id === id);
  }

  listThreads(): Thread[] {
    return [...this.data.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateThread(id: string, patch: Partial<Omit<Thread, 'id'>>): void {
    const t = this.getThread(id);
    if (!t) return;
    Object.assign(t, patch);
    this.scheduleSave();
  }

  deleteThread(id: string): boolean {
    const before = this.data.threads.length;
    this.data.threads = this.data.threads.filter((t) => t.id !== id);
    this.data.messages = this.data.messages.filter((m) => m.threadId !== id);
    this.scheduleSave();
    return this.data.threads.length < before;
  }

  // ── Messages ──
  addMessage(m: Omit<Message, 'id'>): Message {
    const msg: Message = { id: randomUUID(), ...m };
    this.data.messages.push(msg);
    this.updateThread(m.threadId, { updatedAt: m.createdAt });
    this.scheduleSave();
    // Index answers for recall immediately, not only once their digest arrives.
    if (msg.role === 'assistant') {
      const ex = this.exchangeFor(msg);
      if (ex) for (const fn of this.listeners) fn(ex);
    }
    return msg;
  }

  updateMessage(id: string, patch: Partial<Omit<Message, 'id'>>): Message | undefined {
    const m = this.data.messages.find((x) => x.id === id);
    if (!m) return undefined;
    Object.assign(m, patch);
    this.scheduleSave();
    if (m.role === 'assistant' && (patch.content !== undefined || patch.digest !== undefined)) {
      const ex = this.exchangeFor(m);
      if (ex) for (const fn of this.listeners) fn(ex);
    }
    return m;
  }

  threadMessages(threadId: string): Message[] {
    return this.data.messages.filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getMessage(id: string): Message | undefined {
    return this.data.messages.find((m) => m.id === id);
  }

  private exchangeFor(assistant: Message): Exchange | undefined {
    const thread = this.getThread(assistant.threadId);
    if (!thread) return undefined;
    const msgs = this.threadMessages(assistant.threadId);
    const i = msgs.findIndex((m) => m.id === assistant.id);
    const user = msgs.slice(0, i).reverse().find((m) => m.role === 'user');
    return user ? { user, assistant, thread } : undefined;
  }

  /** Every answered question across all threads, oldest first. */
  exchanges(): Exchange[] {
    const out: Exchange[] = [];
    for (const thread of this.data.threads) {
      let pendingUser: Message | null = null;
      for (const m of this.threadMessages(thread.id)) {
        if (m.role === 'user') pendingUser = m;
        // A failed or stopped answer still closes an exchange: the question was asked.
        else if (pendingUser && (m.content.trim() || m.status === 'error' || m.status === 'aborted')) {
          out.push({ user: pendingUser, assistant: m, thread });
          pendingUser = null;
        }
      }
    }
    return out.sort((a, b) => a.user.createdAt.localeCompare(b.user.createdAt));
  }
}
