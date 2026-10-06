# Gateway build test (checklist steps 24–29), 2026-10-05 20:23

Tests for `backend/gateway/`, built from `handoff/gateway-build-2026-10-05-2016.md`.
Sources: that handoff, `AGENTS.md`, `SPEC.md`, `packages/contract/src/http.ts` + `sse.ts`, `benchmark/bench.mjs` (contract probes).

Scripts: `Test Cases/gateway-scripts/run.mjs` (runner) and `mock-agent.mjs` (fake agent: no LLM, no spend).

## How to run

Run from the project root (`MGMT440-1`).

**1. Static (code checks, no servers):**

```
node "Test Cases/gateway-scripts/run.mjs" --mode static
```

**2. Mock (most of the tests).** The runner starts a fake agent on :8001 and the gateway twice: on :8788 pointed at the mock, and on :8789 pointed at a dead agent. The rate limit is lowered to 5/min so the 429 test is quick. Ports 8001, 8002, 8788 and 8789 must be free. It doesn't touch your normal :8787/:8000.

```
node "Test Cases/gateway-scripts/run.mjs" --mode mock
node "Test Cases/gateway-scripts/run.mjs" --mode mock --slow
```

**3. Live (the real stack).** First start `npm run dev:agent` and `npm run dev:gateway` in two terminals. One real ask costs a few cents. The real PDF upload uses OpenAI embeddings.

```
node "Test Cases/gateway-scripts/run.mjs" --mode live
node "Test Cases/gateway-scripts/run.mjs" --mode live --no-upload
```

Each test prints PASS / FAIL / WARN / SKIP with the evidence. The exit code is non-zero if anything fails.

---

## Test cases

### Static (S)
| ID | Checks | Why |
|---|---|---|
| S1 | No changes in `web/ packages/contract/ benchmark/ eval/ quality/ scripts/` | Editing these is a red line |
| S2 | No `compression` import or call in the gateway | Compression buffers SSE |
| S3 | No provider key names (`ANTHROPIC/OPENAI/TAVILY/SERPAPI/MONGODB`) in the gateway source | Keys live only in the agent |
| S4 | No deep cap (`DEEP_DAILY_CAP`) in the gateway | The spend gate belongs in the agent |
| S5 | The `notImplemented` 501 loop is gone | |
| S6 | No `multer`/`busboy` import | Uploads are streamed raw to the agent |
| S7 | `npm run typecheck -w @lumina/gateway` passes | |

### Step 24: auth + CORS (A)
| ID | Checks |
|---|---|
| A1 | All 11 API routes without `X-User-Id` return 401 `{error, status:401, requestId}`, and the agent receives nothing |
| A2 | A blank or whitespace-only `X-User-Id` gives 401 |
| A3 | `/health` and `/evals/report.json` are not 401 |
| A4 | `/` and `/evals` (UI) are not 401. SKIP until `web/dist` is built |
| A5 | An OPTIONS preflight from `localhost:5173` without a user gets a 2xx, the right allow-origin, and allows `x-user-id` (CORS before auth) |
| A6 | A foreign origin gets no allow-origin |
| A7 | `Access-Control-Expose-Headers` includes `x-request-id` |

### Step 25: request id (R)
| ID | Checks |
|---|---|
| R1 | An inbound `X-Request-Id` is echoed on the response and reaches the agent unchanged |
| R2 | When none is sent, one is generated, and the response and the agent see the same id |
| R3 | `X-User-Id` is forwarded to the agent |
| R4 | The request id is on the 400, 401 and 502 responses (header and body) |
| R5 | *(added after review)* An unsafe inbound id (`../../package`, `a/b`, empty, 300 characters) is replaced with a safe one before it's forwarded. The agent writes `runs/<requestId>.json`, so an unchecked id lets a caller write files outside `runs/` |

### Step 26: validation (R)
| ID | Checks |
|---|---|
| V1 | An ask with `{}`, `query:""`, a 2001-character query, `depth:"ultra"` or `mode:"x"` gives 400, the message names the field, and the agent isn't called |
| V2 | Malformed JSON gives 400, not 502 |
| V3 | A valid `{query}` reaches the agent as `mode:"auto", depth:"quick"` (the parsed body is forwarded) |
| V4 | `depth:"deep"` is forwarded as deep. The gateway never changes the depth |
| V5 | `POST /threads`: `{}` gives 201. An empty or 201-character `title` gives 400 |
| V6 | `POST /spaces`: `{}` gives 400. `{name}` gives 201 |
| V7 | `GET /threads/thr_nope` reaches the agent and returns 404 (ids aren't validated at the gateway) |

### Proxy + error mapping (P)
| ID | Checks |
|---|---|
| P1 | Agent 201, 202, 204, 400, 404 and 413 pass through with the same status and body |
| P2 | Agent 500 or 503 becomes 502 with an error body |
| P3 | The agent's deep-cap `429 {error, resetsAt}` on ask passes through with `resetsAt` intact |
| P4 | The query string is preserved |
| P5 | `DELETE /memory/:id` gives 204 with an empty body |
| P6 | With the agent down: the API gives 502 (ask too), and `/health` gives 503 `status:"degraded"`, `ai.status:"down"` |
| P7 | An unknown API path gives 404 JSON |

### Step 27: rate limit (L), with the test limit at 5/min
| ID | Checks |
|---|---|
| L1 | Call #6 gives 429 `{error, status:429, resetsAt (future, ≤60 s), requestId}` and a `Retry-After` of 1–60. The agent gets only 5 calls |
| L2 | A second user isn't affected in the same minute |
| L3 | 25 rapid `GET /spaces/:id/documents` polls never return 429 (the bench polls this every 1.2 s) |

### Step 28: SSE pass-through (E)
| ID | Checks |
|---|---|
| E1 | `text/event-stream`, `no-cache`, `X-Accel-Buffering: no`, and no `content-encoding`, even when the request sends `Accept-Encoding: gzip` |
| E2 | The stream arrives progressively. The mock sends 10 frames 300 ms apart. The first bytes must arrive in under 600 ms, across at least 5 reads spread over more than 2 s |
| E3 | The bytes received are identical to what the agent sent (not re-framed or truncated), in order |
| E4 | If the client disconnects mid-stream, the agent's request is aborted within about 1 s |
| E5 | If the agent returns 404 before streaming, the gateway returns 404 JSON, not SSE |
| E6 | `--slow`: a 36 s stream isn't cut off (no 30 s timeout on ask) |

### Uploads (U)
| ID | Checks |
|---|---|
| U1 | The multipart body reaches the agent byte-identical (sha256), and the `content-type` keeps its boundary. The response is 202 `{docId, status:"pending"}` |
| U2 | An upload over 25 MB gives 413, and the agent never receives it |
| U3 | Three uploads each get a 202 in under 300 ms through the gateway |

### Step 29: logs, report, static UI (G)
| ID | Checks |
|---|---|
| G1+G2 | Exactly one pino line per request, with top-level `method, route, status, ms (or responseTime), requestId, userId`. The logged status matches the real one (200, 401, SSE 200) |
| G2b | A 429 is logged with status 429 |
| G3 | WARN only: `route` is logged as the template (`/threads/:threadId`) |
| G4 | `/evals/report.json` gives 404 ErrorBody with no report. The test makes a temporary `reports/report.json`, expects a 200 JSON, then deletes it |
| G5 | With `web/dist` built, `/` and `/evals` serve `index.html` |
| G6 | No key or connection-string patterns in the gateway logs |

### Live (Z), the real agent and gateway on :8787
| ID | Checks |
|---|---|
| Z1 | `/health` gives 200 and names the model, search provider and vector store, with `db:"ok"` and `ai.status:"ok"` |
| Z2 | The bench's 4 contract probes: 401, 404, 400, and `/evals/report.json` not 401 |
| Z3 | A real quick ask streams `trace → sources → token… → done`, with sources before the first token. Also checked: no `plan` or `plan_research`, every `done` field present, `terminated:"done"`, `depth:"quick"`, every `[n]` has a source, first token in under 2.5 s, and tokens in at least 3 reads |
| Z4 | `runs/<my X-Request-Id>.json` exists, which proves the id flowed browser → gateway → agent |
| Z5 | A real PDF upload gets a 202 in under 300 ms, and polling until `indexed` never hits 429 |
| Z6 | `GET /memory` gives 200. `DELETE /memory/mem_nope` returns the agent's 404 |

### Final gates (you run these, then paste me the output)
- **B1:** `node benchmark/bench.mjs`. All 4 contract probes must show ✓. The deep-search gates will fail until deep search is built, which is expected.
- **B2:** in that bench output, there must be no 429s and an error rate of 1% or less (see the warning below).
- **UI:** run `npm run dev` and open `http://localhost:5173`. The "501 not implemented" panels should be gone. Ask a question and the words should appear gradually, not all at once. Click a citation. The memory and spaces panels should load.

---

## ⚠️ Rate limit vs the benchmark: decide this before you finish step 27

`benchmark/sla.json` runs 40 web asks at concurrency 4, then 30 doc asks, all as **one user (`bench`)**. Half the web asks are cache hits and come back in a second or two. That adds up to well over 30 asks a minute, even if you limit only the ask route. Each ask that gets a 429 counts as an error, and the error-rate limit is 1%.

Your options:
1. Limit only the expensive routes (ask, upload), and raise `RATE_LIMIT_PER_MINUTE` (env, no code change) on the deployed gateway.
2. Keep 30/min but make it a token bucket with a burst allowance.
3. Exempt the bench user. I don't recommend this, because it's a hole anyone could use.

Whichever you pick, record the trade-off in `DESIGN.md` in your own words. Tests L3 and B2 will tell us whether it holds.

---

## Results log

| Run | Mode | Result | Notes |
|---|---|---|---|
| 2026-10-05 20:2x | static | 7/7 PASS | The gateway was already partly built (`guards.ts`, `proxy.ts`). Typecheck is clean |
| 2026-10-05 (Zahid) | mock | 41 PASS · 0 FAIL · 3 SKIP (A4, E6, G5) | Before R5 was added. Code review: R5 gap found; `/evals` excluded from the SPA fallback (affects G5 only if the gateway serves the UI); bench-vs-rate-limit still open |
| 2026-10-05 (Zahid) | mock --slow | 41 PASS · 0 FAIL · 2 SKIP (A4, G5: web/dist not built) | R5 fixed (`SAFE_REQUEST_ID` in `index.ts`); E6 passes (36 s stream). The limiter was rewritten: a per-user token bucket (`RATE_LIMIT_PER_MINUTE`) and a per-IP 120/min on ask and upload, max 5 open asks, 120/min on the other routes. The static checks still pass 7/7 |
| | live | not run yet | |
