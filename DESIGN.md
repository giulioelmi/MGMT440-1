# DESIGN.md — LUMINA

## Components

LUMINA has four running pieces and five pieces of state that make decisions.

- **Web UI** (`web/`, provided). React + Vite, hosted on Vercel. It only ever calls the gateway.
- **Gateway** (`backend/gateway/`, Express, port 8787, public on Fly.io). The edge: CORS,
  the `X-User-Id` check, request ids, request logging, zod validation, a per-user rate limit,
  SSE pass-through to the browser, and serving `/evals/report.json`.
- **Agent service** (`backend/agent/`, Express, port 8000, private on Fly.io). The agent loop
  and its tools (`web_search`, `fetch_page`, `search_documents`, `recall_memory`,
  `save_memory`, and `plan_research` for deep runs only), the deep-search planner and merge,
  the deep-search daily cap, and the run logs.
- **Jobs worker** (`backend/agent/src/worker.ts`, a second Node process from the same
  package). Picks up document-indexing jobs: parse, chunk, embed, write, probe, mark indexed.
- **MongoDB Atlas** (one M0 cluster, database `lumina`). Holds everything, vectors included.
  The parts that carry state or make decisions:
  - the `jobs` collection is the work queue between the upload route and the worker;
  - `searchCache` (with a TTL index) plus an in-memory LRU in the agent form the search cache;
  - `chunks` and `memories` hold the embeddings that vector search reads;
  - `runs` and `requests` are the run logs and request records that `/stats` and the eval read;
  - GridFS holds the uploaded files.
- **External providers**: Anthropic (the LLM), Tavily (search; SerpAPI is swappable through
  `SEARCH_PROVIDER`), OpenAI (embeddings only).

## Responsibilities

- **Web UI** shows things and does nothing else. It holds no keys and makes no decisions.
- **Gateway** is the only component the browser may reach. It decides whether a request is
  allowed in: it rejects a missing `X-User-Id` (`401`), an invalid body (`400`) or a user over the
  per-minute rate limit (`429`). It holds **no provider keys** and never calls an LLM, a search
  API or the database for answers. It does **not** enforce the deep-search cap: a cap at the
  edge could be bypassed by calling the agent directly.
- **Agent service** is the only component that holds provider keys and spends money. It alone
  decides the depth of a run (`quick` unless the request says `deep`; it never upgrades a
  request), whether a run has hit its cap (8 calls / 90 s quick, 24 calls / 240 s deep), and
  whether a user is over `DEEP_DAILY_CAP` (`429 {error, resetsAt}`). It only exposes
  `plan_research` to the model on deep runs, so a quick run cannot call it. It is the only
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
| Threads and messages (incl. sources, deep plan) | `threads`, `messages` | agent | authoritative |
| Long-term memories + embeddings | `memories` (vector index, filtered by `userId`) | agent (`save_memory` only) | authoritative; `GET /memory` shows all of it |
| Uploaded files | GridFS | agent upload route | authoritative |
| Document status (`pending → parsing → embedding → indexed / failed`) | `documents` | worker | authoritative |
| Chunks + embeddings + locator (`page` / `heading` / `line`) | `chunks` (one vector index + one text index, `spaceId` filter) | worker | rebuildable from GridFS |
| Job queue | `jobs` | agent writes, worker claims | authoritative while a job is open |
| Search results | in-memory LRU → `searchCache` (TTL 6 h) | agent | **cache**: deleting it loses nothing |
| Run logs, request records | `runs/*.json`, `runs`, `requests` | agent | authoritative for `/stats` and the eval |
| Deep searches used today | counted from `requests` per `userId` | agent | authoritative for the cap |
| Rate-limit counters | gateway memory | gateway | disposable; reset on restart |

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
3. **The deep-search cap lives in the agent, not the gateway.** That is where the money is spent,
   and the agent is private, so it can't be bypassed. The cost: an over-cap deep request still
   crosses the gateway before being refused, and the cap needs a database count on every deep
   request.
4. **Deep search researches sub-questions in parallel with a small limit (unsure about this
   one).** Running them one after another would be simpler and easier to debug, but with 3–6
   sub-questions it risks the 90 s deep target. Parallel is faster, but it makes the trace
   interleave and makes it easier to hit Tavily's rate limit. I may fall back to sequential if
   the parallel version is hard to read in the trace.
5. **Fail loud instead of degrading gracefully.** A provider error becomes a `502`, never a
   friendly fallback answer. Users see more errors, but a broken dependency cannot hide
   behind `200`s.
