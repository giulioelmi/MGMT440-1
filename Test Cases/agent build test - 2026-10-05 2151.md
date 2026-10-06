# Agent build test: memory (16), deep search (20–22), /stats (23), 2026-10-05 21:51

Tests for `backend/agent/`. Sources: `SPEC.md` §5.3 and §5.5, `AGENTS.md` (Memory, Deep search, Observability), `packages/contract/src/sse.ts` (`PlanEvent`, `Source.subQuestion`, `DoneEvent`), `http.ts` (`Memory`, `StatsResponse`), `db.ts` (`RunLog`), `eval/rubric.json` (`memory`, `deep_search`), `benchmark/bench.mjs` (`runDeepSearch`, `probeDeepCap`, `runMemory`).
Thresholds are read from `benchmark/sla.json`, never hard-coded: plan in under 4000 ms, deep answer in under 90 s, at least 3 sub-questions, at least 2× the sources, deep at most $0.35, quick at most $0.05.

Script: `Test Cases/agent-scripts/run.mjs`. It reads the stream with `benchmark/lib.mjs`'s `ask()` (imported, never edited), so it parses exactly as the grader does.

## How to run

Start the real stack first: `npm run dev:agent` and `npm run dev:gateway`. To also check the agent's log lines (T6), start the agent like this instead:

```
npm run dev:agent 2>&1 | tee agent.log
```

| Command | Covers | Rough cost |
|---|---|---|
| `node "Test Cases/agent-scripts/run.mjs" --only memory` | Step 16 | 4 quick asks, about $0.10 |
| `node "Test Cases/agent-scripts/run.mjs" --only deep,stats` | Steps 20–21, 23 | 1 quick, 1 deep, 1 quick, about $0.45 |
| `node "Test Cases/agent-scripts/run.mjs"` | memory, deep, stats | about $0.55 |
| `node "Test Cases/agent-scripts/run.mjs" --only cap` | Step 22 | the cap's worth of deep runs |
| add `--agent-log agent.log` | T6 | |

For a cheap cap test, restart the agent with `DEEP_DAILY_CAP=2 npm run dev:agent`, run `--only cap`, then restart it normally. If the cap is above 3, the test refuses to run unless you pass `--yes-spend`.

Every test uses a fresh user id, so the tests don't use up your own daily cap or memories, and you can run them again.

---

## Step 16: memory (M)
| ID | Test | Expected |
|---|---|---|
| M1 | `GET /memory` for a brand-new user | **200** `{"memories": []}` |
| M2 | A fresh user asks a one-off fact ("boiling point of water…") | **No** `save_memory` in the trace, and `/memory` is still `[]`. Only stable facts and preferences get saved |
| M3 | Thread A: "Remember this preference for all future answers: I am vegetarian, so never suggest meat or fish." | The trace has `save_memory` with `ok: true`. `GET /memory` lists 1 row: `id` starts with `mem_`, the `text` mentions vegetarian, `createdAt` is ISO, and `sourceThread` = thread A |
| M4 | **New** thread B, same user: "Suggest one dinner recipe…" | The trace has `recall_memory` with `ok: true`. The answer is vegetarian: FAIL if it suggests meat or fish, WARN if it's unclear (read it yourself) |
| M5 | A different user does `GET /memory`, then `DELETE /memory/<A's id>` | They don't see it. The DELETE returns **404**, and A's row is still there |
| M6 | A does `DELETE /memory/<id>` | **204**. The row is gone from `GET /memory`. A second DELETE returns **404** |
| M7 | **New** thread C: the same dinner question | The answer doesn't refer to the deleted preference ("since you're vegetarian…") |
| M8 | `DELETE /memory/mem_doesnotexist` | **404** |

## Steps 20–21: deep search (D)
The question is the first deep query from `benchmark/queries.json` (BM25 vs dense retrieval), the same one the bench asks. It runs once at quick and once at deep, as the same fresh user.

| ID | Test | Expected |
|---|---|---|
| D0 | Deep ask | **200** stream ending in `done`, with no `error` event. Today this fails with **501** if deep isn't built |
| D1 | Event order | `plan` arrives **before** any `web_search` / `fetch_page` / `search_documents` step, and before `sources` and `token`. Only `recall_memory` or `plan_research` may come first |
| D2 | Plan contents | **3–6** sub-questions, `i` = 1, 2, 3… in order, each with question text and a **one-line** `reason`, no duplicates. The plan is printed so you can read it |
| D3 | Plan latency | The plan arrives in under **4000 ms** from the request |
| D4 | Trace tagging | Every retrieval step has `subQuestion` set to a number between 1 and n, and **every** sub-question has at least 1 retrieval step. A failed step has an `error` string |
| D5 | Merged sources | `n` = 1..N with no gaps or repeats. No duplicate `url`, and no duplicate `docId` + locator. Every source has `subQuestion` between 1 and n, and a valid `title`, `snippet`, `url` / `docId` |
| D6 | Citations | The answer cites at least 1 source, and **every** `[n]` matches a source |
| D7 | Deeper, not longer | Distinct sources at deep are at least **2×** the quick run of the same question |
| D8 | `done` + budget | `depth: "deep"`, `subQuestions` = the plan size, `terminated: "done"` (`cap` gives a WARN), cost at most **$0.35**, at most **24** tool calls, at most **90 s**, exactly one `plan_research` step with `ok: true` |
| D9 | Structure (a Should, so WARN only) | At least 3 section headings (`##` or `**bold**` lines) and a "still unknown / open questions" part |
| D10 | Run logs (local only) | `runs/<requestId>.json` has `depth: "deep"`, the same `terminated` and `costUsd` as `done`, a `plan_research` call, and stays within 24 calls / 240 s / $0.35. The quick baseline's log has `depth: "quick"` and **no** `plan_research` |
| D11 | Thread keeps it | `GET /threads/<id>`: the last assistant message has the same number of sources, and `done.depth` is `deep`. WARN if the plan itself isn't stored (SPEC §5.3) |
| D12 | Quick never escalates | **No `depth` field sent**, with a query that begs for depth ("Research this in depth with several sub-questions…"). Expected: **no** `plan` event, **no** `plan_research`, `done.depth: "quick"`, `subQuestions` absent or 0, at most 8 calls, at most $0.05 |

## Step 22: deep daily cap (C), run with `--only cap`
| ID | Test | Expected |
|---|---|---|
| C1 | A fresh user runs `deepDailyCap` (K) deep searches | All K are accepted and finish |
| C2 | Deep search number K+1 | **429** `{"error": "…", "resetsAt": "<ISO, in the future, within 25 h>"}`, as JSON, not a stream |
| C3 | The 429 is decided before any spend | It comes back in under **1.5 s**, with **no** `runs/<requestId>.json` written (the check runs before planning or searching) |
| C4 | The same capped user asks a quick question | **200**. The cap only gates deep |
| C5 | Deep ask sent **straight to the agent** (`:8000`), skipping the gateway | **429**. This proves the gate is in the agent, not the gateway. SKIP if the agent isn't reachable |
| C6 | `/stats` for the capped user | `deepToday` = K and `deepDailyCap` = K. The refused attempt isn't counted |
| C7 | `/stats` for another user | `deepToday` = 0. The cap is per user |

## Step 23: /stats (T)
| ID | Test | Expected |
|---|---|---|
| T1 | `/stats` shape (fresh user) | All 7 fields are present: `requests`, `answers`, `deepToday`, `deepDailyCap` (whole numbers ≥ 0), `searchCacheHitRatePct` (0–100), `ttftP95Ms`, `costUsdToday` (≥ 0). `deepToday` is 0 and `deepDailyCap` is at least 1 |
| T2 | After the deep run | The deep user's `deepToday` goes **0 → 1**. The quick baseline doesn't count |
| T3 | Another user | `deepToday` = 0 |
| T4 | Before and after one quick ask | `answers` goes up by **1**, and `costUsdToday` goes up by that answer's `done.costUsd` (±$0.0002). WARN if something else is using the stack at the same time |
| T5 | `ttftP95Ms` | Above 0 and below 60 000 |
| T6 | Agent log (`--agent-log`) | Exactly **one** JSON line for the deep run's `requestId`, with `requestId, toolCalls, terminated, tokens, costUsd, searchCached, ttftMs, latencyMs`. Its `terminated` and `costUsd` match `done` |

## Final gate (bench)
`node benchmark/bench.mjs` should show these as passing: `deepPlan`, `deepAttribution`, `deepReadsMore`, `deepBudget`, `quickNeverEscalates`, `quickBudget`, `deepCap429`, `memorySaved`, `memoryRecalled`, `memoryDeleted`.
The bench uses `DEEP_DAILY_CAP` + 2 deep runs for its cap probe and 4 deep questions, so leave the cap at its normal value (5) for the bench.

**Human check (rubric `deep_search_quality`, judged by a person):** read the quick and deep answers to D's question side by side. The deep one has to be *better*: broader coverage, sources the quick one missed, sub-questions you'd actually ask, no padding.

---

## Results log
| Run | Scope | Result | Notes |
|---|---|---|---|
| | memory | not run yet | |
| 2026-10-05 (Zahid) | deep,stats | 17 PASS · **1 FAIL (D3)** · 1 SKIP (T6) | Plan at **4693 ms**, over the 4000 ms limit. The planner runs on `claude-sonnet-5` because `PLANNER_MODEL` is unset, so `env.ts` falls back to `LLM_MODEL`. Deep: 6 sub-questions, 12 sources vs 3 at quick (4×), $0.13, 20 calls, 41.6 s. Quick-escalation bait stayed quick (5 calls, $0.029). Watch: `/stats` ttftP95 was 16.6 s; check quick TTFT on its own (gateway live Z3, bench) |
| | cap | not run yet | |
