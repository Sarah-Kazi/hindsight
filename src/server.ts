import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config, configProblems } from './config.ts';
import { getModels } from './llm.ts';
import { Store } from './memory/store.ts';
import { Recall } from './memory/recall.ts';
import { createTavily } from './search/tavily.ts';
import { Agent, type TurnEvent } from './agent/turn.ts';
import { publicMessage } from './agent/history.ts';
import { warmUp } from './time.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const store = new Store(config.dataDir);
const recall = new Recall(store);
const models = getModels();
const agent = new Agent(store, recall, models, config.tavilyKey ? createTavily(config.tavilyKey, config.searchConcurrency) : null);
const pendingDigests = agent.catchUpDigests();
warmUp();

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({ provider: config.provider, model: models?.mainId ?? null, fallbacks: models?.chain?.slice(1).map((m) => m.id) ?? [], search: Boolean(config.tavilyKey), problems: configProblems() }),
);

app.get('/api/threads', (c) => c.json(store.listThreads()));

app.get('/api/threads/:id', (c) => {
  const thread = store.getThread(c.req.param('id'));
  if (!thread) return c.json({ error: 'Not found' }, 404);
  return c.json({ thread, messages: store.threadMessages(thread.id).map(publicMessage) });
});

app.delete('/api/threads/:id', (c) => (store.deleteThread(c.req.param('id')) ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)));

app.post('/api/chat', async (c) => {
  const body = await c.req.json().catch(() => null);
  const text = typeof body?.message === 'string' ? body.message.trim() : '';
  const threadId = typeof body?.threadId === 'string' ? body.threadId : undefined;
  if (!text) return c.json({ error: 'Message is empty.' }, 400);
  if (text.length > config.maxUserMessageChars) return c.json({ error: `Message is too long (max ${config.maxUserMessageChars} characters).` }, 413);
  if (threadId && !store.getThread(threadId)) return c.json({ error: 'Chat not found.' }, 404);

  return streamSSE(c, async (stream) => {
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort()); // user pressed stop or closed the tab
    // A small queue keeps SSE writes ordered even though events arrive from parallel tool calls.
    let chain = Promise.resolve();
    const emit = (e: TurnEvent) => {
      chain = chain.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
    };
    await agent.turn({ threadId, text, tz: body?.tz, signal: ctrl.signal, emit });
    await chain;
  });
});

// Static UI + browser builds of the markdown libraries, served from node_modules (no CDN needed).
app.get('/vendor/marked.js', serveStatic({ path: path.join(root, 'node_modules/marked/lib/marked.esm.js') }));
app.get('/vendor/purify.js', serveStatic({ path: path.join(root, 'node_modules/dompurify/dist/purify.es.mjs') }));
app.use('/*', serveStatic({ root: path.join(root, 'public') }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  Hindsight is running → http://localhost:${info.port}`);
  console.log(`  model: ${models ? `${models.provider} / ${models.mainId} (digests: ${models.fastId})` : 'NOT CONFIGURED'}`);
  console.log(`  search: ${config.tavilyKey ? `tavily (${config.searchDepth})` : 'NOT CONFIGURED'} · data: ${config.dataDir}`);
  if (pendingDigests) console.log(`  memory: catching up on ${pendingDigests} undigested exchange(s) in the background`);
  for (const p of configProblems()) console.warn(`  ⚠ ${p}`);
  console.log('');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is in use. Set PORT in .env to another port.`);
  else console.error(err);
  process.exit(1);
});

// Save memory before exiting (Ctrl+C, or tsx watch restarting).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await Promise.race([agent.idle(), new Promise((r) => setTimeout(r, 1500))]);
    store.flush();
    process.exit(0);
  });
}
