# LUMINA: manual test findings

**Started:** 2026-10-09 · **Tester:** Zahid · **Against:** the deployed app (https://mgmt440-lumina.vercel.app → https://mgmt440-lumina-gateway.fly.dev)
**Code deployed:** `main` at `3cec6f0` (the planner change on `zahid/deep-plan-quality` is not deployed yet)

How to use this file: one row per test as it runs. Every problem gets a request ID (trace panel or the `X-Request-Id` header). Severity:
- **Must fix**: crash, invented citation, leaked key, broken cap.
- **DESIGN.md**: slow or imperfect but honest; explain it rather than fix it.
- **Info**: expected behaviour, recorded for reference.

---

## 1. Findings

| # | Bucket | What we saw | Cause | Severity | Decision |
|---|---|---|---|---|---|
| M1 | A. Basic loop | Asking the same question twice, once with `?` and once without, was a **cache miss** both times (the second ask cost $0.027 and 4.1 s TTFT instead of ~1–1.5 s). | Quick searches the question exactly as typed (`ask.ts:569`), and the cache key only lowercases and collapses spaces (`normalizeQuery`, `search.ts:28`). Punctuation is part of the key, so `default?` and `default` are different searches. | DESIGN.md | Don't fix now: the bench repeats questions character for character (run 4 hit 50%), and a fix means another redeploy and makes old cache entries unreachable. One-line fix if wanted later: strip punctuation in `normalizeQuery`. |
| M2 | A. Basic loop | First quick answer: **TTFT 6.1 s** (total 7.9 s), above the usual 3–5 s on a new question. | Not yet known. Candidates: Tavily slow (known), the model slow to start, or the first request after the agent was restarted. | Pending | Check `web_search` time in the trace: 2–4 s = Tavily (known issue); under 1.5 s = model start-up. |

### Raw numbers

| Run | Question | TTFT | Total | Tokens in/out | Cost | Cache |
|---|---|---|---|---|---|---|
| A1 | `What port does MongoDB listen on by default?` | 6105 ms | 7948 ms | 5215 / 194 | $0.0204 | miss (first ask) |
| A1b | same, without the `?` | 4107 ms | 6531 ms | 8300 / 284 | $0.0274 | miss (see M1) |

Both stayed within the quick budget (≤ $0.05) and the answer time target (≤ 12 s), and both were about 200 words or less. Input tokens differ because the second ask got different search results (and, in the same thread, the first exchange as history).

### Still to run
- A1c: the first question again, pasted **exactly**: should be a cache hit with TTFT ~1–1.5 s. A miss here is a real bug.
- Buckets B–L from the test plan.

---

## 2. Process findings from the 2026-10-09 review (before Phase 6)

| # | Finding | What to do |
|---|---|---|
| P1 | DESIGN.md answers and the "How I ran it" notes go **into the eval config** that `/fde-lumina-eval` (step 41) renders on `/evals` (assignment `TECHNICAL.md`). | Write DESIGN.md **before** step 41, not after the video. |
| P2 | `scripts/export-runs.mjs` reads `MONGODB_URI` from the **local** `.env` and dumps the latest 500 runs, from every user. | Check that `.env` points at the same Atlas cluster as the deployed agent's secret; look at what was exported. |
| P3 | Local `runs/` has 79 logs, **30 ended in error or cap** (today's 401s, cancelled plan tests, Mubarak's run 2). Rule A2 fails on them. | Move (don't delete) everything into `runs-archive/` before exporting. |
| P4 | `fly.agent.toml` has no `[http_service]` (on purpose: the agent is private), so Fly never wakes it on a request. It was found stopped on 2026-10-09. | Find out why it stopped (`fly logs`, `fly machine status 832476c7695108`); check `/health` before the bench, the video and submission. **Answered:** `fly machine status` event log shows `launch` with `migrated=true` at 2026-10-09 09:37 PT, then `stopped` (source `flyd`) at 09:38: Fly moved the machine to a new host and it came up stopped. Not a crash or OOM. Zahid restarted it at 20:00 PT (source `user`). With no `[http_service]`, nothing wakes it after a migration, so the `/health` checks above still apply. |
| P5 | `fly deploy` uploads the local folder, not GitHub. | Deploy only after the PR is merged and pulled, with a clean working tree. |
| P6 | Deep search is capped at 5 per user ID per day, and manual testing uses most of that. | Test under a separate user ID (`zahid-test`, `cap-test`); record the video as a fresh user. |
| P7 | Manual test runs are saved to Mongo and will be exported with the graded runs. | Finish manual testing before archiving `runs/` and exporting for step 39. |
| P8 | Step 40 done locally (user `zahid-failing`, bad Tavily key): `502` + `req_8004d006-bb5`, log in `runs/failing/`: `terminated: "error"`, `recall_memory` ok → `web_search` `ok: false` with `tavily 401`, 0 tokens, $0. It stopped before the model ran, so no answer was made up. | Restore the real Tavily key in `.env`. Use this ID as `--failing` in step 41. |
| P9 | `eval/build-report.mjs` (step 41) takes `--video <url>` and `--design DESIGN.md`, plus notes in the student's own words for both runs. | Record and upload the video, and finish DESIGN.md, **before** step 41. |

## 3. Planner change (branch `zahid/deep-plan-quality`, commit `4f0b13f`, not pushed or deployed)

`plannerPrompt()` in `ask.ts`: "Make one about what real products or teams actually do." → "One asks which real products or teams use which option, and why, nothing more." Tested on 3 bench deep questions × 3: the tacked-on angle Mubarak saw ("…and their CDN deployments") was gone in 10/10 plans, plan time unchanged (3.1–3.5 s). The SSE/CDN question still gives two overlapping CDN sub-questions in 2 of 4 plans. Kept; no more tuning.

## 4. Step 41 notes, in Zahid's words

### Failing run: `--failing req_8004d006-bb5` (for `--failing-notes`)

I deliberately broke the Tavily API key to see how the app would handle a failed search. My request returned a 502 in about 1.1 seconds, with a request ID I could use to trace the failure. I received no answer or citations. The client received Tavily’s credentials error message, but the API key itself never left the server; I did not see the message because my curl command discarded the response body.

What stood out to me was that the app stopped before calling Claude, even though memory retrieval succeeded. A broken search is different from a search that finds nothing: the app cannot know what the sources say when it cannot access them. Since my question asked about pricing changes this month, answering from training data could have produced an outdated response while appearing successful. Stopping preserved the promise of source-backed answers and kept model tokens and cost at zero.

The run log made the cause easy to identify. Using request ID `req_8004d006-bb5`, I found the failed `web_search` step and Tavily’s 401 message stating that the API key was missing or invalid. This showed me that a useful failure needs both an honest response to the user and enough detail internally to diagnose the problem quickly.

### Successful run: `--successful req_25eb07b0-2e3` (for `--successful-notes`)

After deliberately breaking a run, I wanted to see what a healthy one looked like, so I read a successful deep search step by step. It finished in 41 seconds, costing $0.111 and using 28,906 tokens across 18 successful tool calls. It stayed within all three budgets: 24 tool calls, 90 seconds and $0.35.

What stood out was where the time went. After memory retrieval, the plan took about 2.5 seconds, below the 4-second target, and arrived before any searching began. Each search took roughly 2.4–3.2 seconds, while each page read took just 1–7 milliseconds because Tavily had already returned the page text. Those reads were lookups rather than new downloads. The tools accounted for about 14.5 seconds overall, leaving roughly 26 seconds largely spent on Sonnet processing twelve sources and writing the answer. That showed me that making deep search faster would mean looking at search latency and answer generation; there was very little time left to save on page reads.

I also noticed the repeated pattern of one search followed by three page reads, once for each of the four sub-questions. Processing them sequentially made the research easy to follow and avoided the burst of reads that the A3 rule flags as “tool thrash.” The trade-off was giving up the speed of parallel research. I would consider testing parallel execution with clearer grouping in the trace, but I would need to check whether it still satisfied the rule rather than assume that changing the presentation solved it.

Reading this alongside the failed run helped me understand what each trace tells me. In the failed run, I looked for the first broken step and why execution stopped. In the successful run, I could follow where the time and money went and assess the choices behind them. Having that healthy example gives me a baseline for spotting unusual behavior in later runs.

### For DESIGN.md
- The 502 body passes the provider's raw error message to the client (`ask.ts:681`). No key is exposed, but a generic message with details only in the logs would be safer. Not changed, to avoid another redeploy.
