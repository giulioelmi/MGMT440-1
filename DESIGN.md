# DESIGN.md — LUMINA

## Components

LUMINA has four running pieces and five pieces of state that make decisions.

- **Web UI** (`web/`, provided). React + Vite, hosted on Vercel. It only ever calls the gateway.
- **Gateway** (`backend/gateway/`, Express, port 8787, public on Fly.io). The edge: CORS,
  the `X-User-Id` check, request ids, request logging, zod validation, layered rate limits,
  SSE pass-through to the browser, and serving `/evals/report.json`.
- **Agent service** (`backend/agent/`, Express, port 8000, private on Fly.io). The agent loop
  and its tools (`web_search`, `fetch_page`, `search_documents`, `recall_memory`,
  `save_memory`, and `plan_research`, which the agent calls itself on deep runs only), the
  deep-search planner (a smaller, faster model) and merge, the deep-search daily cap, and the
  run logs.
- **Jobs worker** (`backend/agent/src/worker.ts`, a second Node process from the same
  package). Picks up document-indexing jobs: parse, chunk, embed, write, probe, mark indexed.
- **MongoDB Atlas** (one M0 cluster, database `lumina`). Holds everything, vectors included.
  The parts that carry state or make decisions:
  - the `jobs` collection is the work queue between the upload route and the worker;
  - `searchCache` (with a TTL index) plus an in-memory LRU in the agent form the search cache;
  - `chunks` and `memories` hold the embeddings that vector search reads;
  - `runs` and `requests` are the run logs and request records that `/stats` and the eval read;
  - `deepUsage` holds each user's deep-search count for the day (the spend gate);
  - GridFS holds the uploaded files.
- **External providers**: Anthropic (the LLM), Tavily (search; SerpAPI is swappable through
  `SEARCH_PROVIDER`), OpenAI (embeddings only).

## Responsibilities

- **Web UI** shows things and does nothing else. It holds no keys and makes no decisions.
- **Gateway** is the only component the browser may reach. It decides whether a request is
  allowed in: it rejects a missing `X-User-Id` (`401`), an invalid body (`400`) or a caller over
  a rate limit (`429`: too many open answer streams, too many asks or uploads per minute, too
  many requests overall, or too many from one IP). It holds **no provider keys** and never calls an LLM, a search
  API or the database for answers. It does **not** enforce the deep-search cap: a cap at the
  edge could be bypassed by calling the agent directly.
- **Agent service** is the only component that holds provider keys and spends money. It alone
  decides the depth of a run (`quick` unless the request says `deep`; it never upgrades a
  request), whether a run has hit its cap (8 calls / 90 s quick, 24 calls / 240 s deep), and
  whether a user is over `DEEP_DAILY_CAP` (`429 {error, resetsAt}`). `plan_research` is never
  offered to the model: the agent calls it itself, and only on a deep run, so a quick run cannot
  escalate itself into a deep one. It is the only
  writer of memories, and only through an explicit `save_memory` call. On a provider exception it
  ends the run with `terminated: "error"` and a `502`, never a made-up answer.
- **Jobs worker** is the only component allowed to parse, chunk and embed documents, and the only
  one that may set a document to `indexed`, and only after the read-your-write probe returns
  one of its chunks. The upload route only stores the file and queues the job.
- **MongoDB** is the source of truth for threads, messages, memories, documents, chunks and jobs.

## Communication

- **Browser → gateway:** HTTP for normal routes; Server-Sent Events (SSE) for
  `POST /threads/{id}/ask`, so the answer streams token by token
  (`plan → trace → sources → token → done`). SSE rather than WebSockets because the stream
  only goes one way and works over plain HTTP.
- **Gateway → agent:** the same HTTP contract, forwarded with `X-User-Id` and `X-Request-Id`.
  The gateway pipes the agent's SSE stream straight through without buffering (compression off,
  flush after every event). If the agent is down, the gateway returns `502` instead of hanging. If
  the browser disconnects mid-answer, the gateway closes the upstream request so the agent
  stops spending.
- **Agent → providers:** HTTPS calls to Anthropic, Tavily and OpenAI. Any failure is a visible
  `trace` step with `ok: false` and an error message. If the LLM itself fails, the run ends with
  `terminated: "error"` and `502`.
- **Agent → worker:** no direct connection. They communicate through the `jobs` collection: the
  upload route inserts a `pending` job and returns `202`; the worker claims it with an atomic
  `findOneAndUpdate` (`pending → running`, setting `claimedAt`). If the worker crashes, the job stays
  `running` with an old `claimedAt`, and a sweeper puts it back to `pending`. Finished stages are
  recorded so they are not re-run. A queue in Mongo means no Redis or broker to run.
- **One request id end to end:** the gateway reuses the incoming `X-Request-Id` or creates one,
  logs it, and forwards it; the agent logs it and names the run log `runs/<requestId>.json`.

## State

| What | Where | Owner | Authoritative or cache? |
|---|---|---|---|
| Threads and messages (incl. each answer's sources, depth and sub-question count) | `threads`, `messages` | agent | authoritative |
| Long-term memories + embeddings | `memories` (vector index, filtered by `userId`) | agent (`save_memory` only) | authoritative; `GET /memory` shows all of it |
| Uploaded files | GridFS | agent upload route | authoritative |
| Document status (`pending → parsing → embedding → indexed / failed`) | `documents` | worker | authoritative |
| Chunks + embeddings + locator (`page` / `heading` / `line`) | `chunks` (one vector index + one text index, `spaceId` filter) | worker | rebuildable from GridFS |
| Job queue | `jobs` | agent writes, worker claims | authoritative while a job is open |
| Search results | in-memory LRU → `searchCache` (TTL 6 h) | agent | **cache**: deleting it loses nothing |
| Run logs, request records | `runs/*.json`, `runs`, `requests` | agent | authoritative for `/stats` and the eval |
| Deep searches used today | `deepUsage`, one counter per user per UTC day | agent | authoritative for the cap and for `/stats` `deepToday` |
| Rate-limit counters (per-user token buckets, open-stream counts, per-IP counts) | gateway memory | gateway | disposable; reset on restart |

**Written but not yet searchable.** Atlas Search indexes update a little after a write, so a chunk
that was just inserted may not be found yet. The worker therefore keeps the document at
`embedding` after writing its chunks, then queries the vector index for one of them until it comes
back (with a timeout that marks the document `failed`). Only then does it set `indexed`. So
`indexed` means "searchable", not just "saved".

## Trade-offs

1. **Atlas Vector Search instead of a separate vector database.** Each chunk's text, locator and
   embedding sit in one document, so a citation is one lookup and `spaceId` is a plain filter
   inside `$vectorSearch`. The cost: the free M0 tier allows only three search indexes, which is
   exactly what LUMINA needs, leaving no room for experiments, and search updates lag writes
   (hence the probe).
2. **Job queue in a Mongo collection instead of Redis or a message broker.** One fewer service
   to deploy and pay for, and the job state is visible with a normal query. The cost: the worker
   polls, so a new upload waits up to one poll interval before work starts, and I had to write the
   claim, sweep and retry logic myself.
3. **The deep-search cap lives in the agent, not the gateway, as an atomic counter.** That is
   where the money is spent, and the agent is private, so it can't be bypassed. Each deep request
   claims a slot with one atomic update on a per-user, per-UTC-day counter (`deepUsage`): the
   update only matches while the count is under `DEEP_DAILY_CAP`, so two parallel requests can't
   both take the last slot. Over the cap it returns `429` with `resetsAt` (the next UTC midnight),
   and `/stats` reads the same counter, so the two never disagree. Tested with a cap of 2:
   allowed, allowed, then `429`, and `deepToday` read 2 of 2. The cost: an over-cap request still
   crosses the gateway before being refused; every deep request pays one extra database round
   trip; and a slot is counted when the run starts, not when it finishes, so a run that fails
   after it has started streaming still uses one up. Only a run that fails before anything is
   streamed (for example, the planner is down) gets its slot back.
4. **Deep search researches sub-questions in parallel, at most 3 at a time.** Running them one
   after another would be simpler and the trace easier to read, but with every sub-question
   searching and reading pages, it risks the 90 s target. In testing, deep answers took 37–57 s
   and $0.12–0.16, used 17–20 of the 24 allowed tool calls, and read 11–12 distinct sources
   against quick's 3 for the same question (the SLA asks for 2×). A page one sub-question has
   already read is skipped by the others, so the merged list grows instead of repeating, and
   pages per sub-question shrink automatically for long plans so the fan-out stays under the
   24-call cap, with 2 calls held back for the answer step. What I gave up: trace steps from
   different sub-questions interleave, so every step and source carries its `subQuestion` number
   to stay readable; parallel searches make it easier to hit Tavily's rate limit; and one
   sub-question can't build on what another found, because they all start from the same plan.
5. **Fail loud instead of degrading gracefully.** A provider error becomes a `502`, never a
   friendly fallback answer. Users see more errors, but a broken dependency cannot hide
   behind `200`s.
6. **Rate limits are layered by cost, use token buckets, and live in gateway memory.** One flat
   "30 requests a minute" would either block normal use or fail to protect the expensive
   routes, so the gateway has four layers:
   - **Concurrent asks:** at most 5 `POST /threads/{id}/ask` streams open per user. An answer
     stream runs for seconds to minutes, so limiting what is open at once controls spend better
     than counting requests.
   - **Expensive routes:** asks and document uploads share a per-user token bucket of 30 that
     refills at 30 a minute (`RATE_LIMIT_PER_MINUTE`). A bucket allows a short burst and then a
     steady rate, where a fixed one-minute window would let through double at the minute
     boundary.
   - **Everything else:** a loose 120 a minute per user. The UI and the benchmark poll a
     document's status every 1.2–1.5 s while it indexes (about 40–50 a minute), and that must
     not turn into `429`s.
   - **Per IP:** a backstop of 120 a minute on asks and uploads, because `X-User-Id` is a header
     anyone can change, so a per-user limit alone is easy to dodge.

   `/health`, `/evals/report.json`, static files and CORS preflights are exempt. Every `429`
   carries `Retry-After`, `RateLimit-*` headers and `resetsAt`, and idle counters are cleared
   so rotating user ids cannot fill memory. This is separate from the deep-search daily cap,
   which is a spend quota and stays in the agent. What I gave up: the per-IP limit is generous
   because the benchmark and grader send everything from one IP, so users behind one office
   network share a budget; and the counters live in the gateway's memory, so they reset on a
   restart and are not shared across machines. That is fine for one Fly machine; more than one
   would need a shared store such as Redis. **Unsure:** the concurrency limit of 5 is a guess
   that leaves headroom over the benchmark's 4 parallel asks, and I will confirm it with a
   benchmark run.
7. **Deep search's planner uses a smaller model (Haiku 4.5) than the answer (Sonnet 5).** The
   plan is the first thing a deep search shows, and the SLA gives it 4 s at p95
   (`deep_plan_p95_ms`). With Sonnet as the planner, the plan arrived at 6.1 s and 12.7 s on
   default effort; on low effort the planner call alone took 4.1 s and the plan arrived at
   4.3–4.7 s, still over. Splitting a question into searchable sub-questions is easy work compared
   with writing the answer, so it goes to the faster model, and Sonnet still writes the answer
   from every source. To get the rest of the way, the planner writes less (exactly 4 short
   sub-questions with short reasons) and is hedged: the call is streamed, and if the model hasn't
   started writing by 1.5 s, or there is still no plan by 3.5 s, an identical second call starts
   and the first good plan wins. With all of that, the plan arrived in 3.0–3.9 s across six runs.
   What I gave up: a smaller model may split a question less sharply, and a weak plan weakens
   everything after it, because each sub-question decides what gets searched and read. The first
   Haiku plans were weak in exactly this way (one sub-question per option, an overview that
   overlapped the rest, and once a constraint the user never stated), so the prompt now tells it
   to split by the factors that decide the answer, avoid overlaps, include one real-world
   question and never add assumptions, with one worked example. I judged plan quality by reading
   plans, not with a metric. The planner is also forced to call a `plan_research` tool with a fixed
   schema rather than write free text, and fewer than 3 usable sub-questions starts a replacement
   call; a non-retryable error fails loud with a `502`. The margin is thin (slowest plan 3.9 s
   against 4 s), and the lever left is planning 3 sub-questions instead of 4. It is configurable
   (`PLANNER_MODEL`), so switching back to Sonnet is one setting. Reported costs still price the
   planner's tokens at Sonnet's rate, so deep costs are slightly over-reported, which is the safe
   direction for the $0.35 cap.
