# Hindsight: design

## The problem, re-read

The brief's examples are about **memory over time** more than search. *"What did I ask you on 3 November?"* needs date-indexed history across chats. *"Has pricing changed since then?"* needs a **baseline**: what the agent said then, and from which source. *"Last Tuesday"* needs weekday arithmetic, which models often get wrong. And a reviewer's fresh copy has **no history**, so the worst answer is a made-up past conversation.

One rule shaped the design: **never guess about the past, never guess about the present.** The past comes from code, the present from search.

## How a turn works

```
message ─► 1. PRE-FLIGHT (code only, ≈1 ms)
           ├─ time.ts    "last Tuesday" → exact local days (+ alternatives if ambiguous)
           └─ recall.ts  MEMORY: index of all past exchanges · full detail for named days,
                         or an explicit <no_record> · topic search for vague references
       ─► 2. AGENT LOOP (answer.ts; one tool: web_search)
           ├─ parallel searches (5 CRMs → ≥5 in one step), ≤6 steps, 45 s / 120 s budget
           └─ on 429/503 the next model continues from the searches already done;
              each model rests as long as its provider says; if all fail, one more pass
       ─► 3. CITATION CHECK (code): each cited figure must appear in its source's text
       ─► 4. BACKGROUND DIGEST (cheap model): topic synonyms + a CLAIMS LEDGER
```

**Re-checking an answer.** Each item needs the **current state** (official page, *no* date filter, because pricing pages are old pages that get edited) and **change events** (`since=<that day>`). The verdict is *Changed*, *No change found* or *Couldn't verify*. "No news" is never proof of no change.

## Why it's built this way

| Decision | Why |
|---|---|
| **Memory injected before the turn, not a tool** | The brief allows one tool. Models often skip recall tools, and a skipped recall becomes a made-up memory. No extra model round-trip. |
| **Dates computed in code** | Exact, testable, time-zone aware (each message stores the user's *local* day). Ambiguity is shown: "last Tuesday" said on a Wednesday gives both readings. |
| **Re-check plan written in code** | Live evals showed the model searching only for news and concluding "no change". Now code lists the earlier answer's items and requires both searches for each. |
| **Claims ledger points back to the answer** | Precise "then vs now", but the model also sees the original wording, so an extraction slip can't become a wrong "then". A failed answer is remembered as failed. |
| **Own search tool on Tavily** | Date and domain filters, page passages not snippets, stored excerpts, retries, results fenced as untrusted text. |
| **Deterministic citation check** | The most damaging failure is a wrong figure with a real-looking citation. Caught in <1 ms, no model call. |
| **JSON file + in-memory index** | No native add-ons, so `npm install` can't fail. Atomic writes; a corrupt file is backed up. |
| **Vercel AI SDK, own loop** | One interface across Gemini, Claude and OpenAI; the loop, fallbacks and limits stay readable code. |

Every answer has an **Inspect** panel: resolved dates, the exact memory the model got, each step's time and tokens, searches, fallbacks and the citation check. It shows *why* an answer came out the way it did.

**Speed:** no model call before the first token, parallel searches, a cacheable prompt prefix, low Gemini thinking, date-parser regexes warmed at startup, digests off the critical path.

**Found by running it live, then fixed:** Gemini thinking by default (≈500 hidden tokens before the first word); the SDK waiting out `retry-after` before falling back; old `[n]` citations leaking into new answers; links breaking inside Markdown tables.

## Considered and rejected

- **Memory as a second tool**: breaks the brief and is less reliable.
- **Vector DB / embeddings**: an extra key, extra latency and a service to run. Dates plus fuzzy search over model-written synonyms are enough for one user.
- **SQLite**: a native add-on that can fail to install.
- **Planner → executor agents**: a round-trip before any work. Parallel tool calls already split it.
- **Model-based date parsing**: wrong weekdays, untestable.
- **LangChain / LangGraph**: heavy abstraction over a loop I can explain line by line.

## Verification

`npm test`: 44 tests with a scripted model, no keys needed (dates, recall, fallback and resume, deadlines, stop, citation check, prompt injection). `npm run eval`: the brief's scenarios live on a back-dated clock. Last run: 15/15 checks during a Gemini outage.

## With another week

1. **Diff page text directly**: excerpts are already saved, so "has it changed?" could quote the changed line.
2. **Evals with a model judge** (groundedness, no made-up memory, verdicts), replayed from recorded searches in CI.
3. **Meaning-level citation checks**, not just figures.
4. **Watch lists**: "keep an eye on these 5 CRMs" → scheduled re-checks.
5. **Multiple users** behind the same `Store` interface.
