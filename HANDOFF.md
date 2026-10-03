# LUMINA: where we are (handoff notes)

Written for teammates (and their coding agents) picking up the later parts.
Plain English first; technical pointers at the end of each section.

**Read these before you change anything:** `AGENTS.md` (the rules, some of which are
"automatic fail" if broken) and `DESIGN.md` (how the system is laid out and why).

---

## 1. What LUMINA is, in one paragraph

LUMINA is a homemade Perplexity. You type a question, it searches the web (and/or
documents you uploaded), reads the pages, and writes an answer that streams in word by
word, with numbered citations like [1] that point to the pages it actually read. It
also remembers things you tell it about yourself. The course gave us the website (the
UI) and the rules; **we build the two "back-office" programs** behind it.

## 2. The three pieces (an analogy)

Think of a restaurant:

| Piece | Restaurant role | Folder | Status |
|---|---|---|---|
| **Website (UI)** | the dining room | `web/` | Provided by the course. **Do not edit.** |
| **Gateway** | the front desk: checks who you are, turns away bad requests, passes orders to the kitchen | `backend/gateway/` | **Not built yet** |
| **Agent** | the kitchen: does all the real work, holds all the secret keys | `backend/agent/` | **Mostly built** (see below) |
| **Database** | the pantry: MongoDB Atlas holds everything | (cloud) | Set up |

The website only ever talks to the gateway. The gateway only talks to the agent.
Only the agent holds the passwords for the AI, the search engine and the database.

## 3. Progress checklist

| # | Part | Status |
|---|---|---|
| 1 | Accounts, keys, database indexes | ✅ done |
| 2 | `DESIGN.md` (graded design write-up) | ✅ done (first draft; owner should reword in their own voice) |
| 3 | **Quick search**: question → search → read pages → cited answer | ✅ built and tested on a real Mac |
| 4 | **Search memory (cache)**: repeat questions reuse old search results | ✅ built and tested |
| 5 | **Conversations (threads)** saved, follow-ups see earlier messages | ✅ built and tested |
| 6 | **Long-term memory**: "remember I prefer short answers" | ✅ built, **not yet tested** |
| 7 | **Receipts (run logs)**: one file per answer for the grader | ✅ built and tested |
| 8 | **Upload your own documents** (PDF / Markdown / text) | ✅ built, **not yet tested** |
| 9 | **Search your documents** with page numbers in citations | ✅ built, **not yet tested** |
| 10 | **Deep search**: plan sub-questions, research each, merge citations | ❌ **next** (15 + 5 points) |
| 11 | **Gateway** (the front desk) | ❌ to do |
| 12 | Put it online (Fly.io for the back-office, Vercel for the website) | ❌ to do |
| 13 | Run the official grader and publish the results page (`/evals`) | ❌ to do |

---

## 4. How the built parts work (plain English)

### Answering a question ("quick search")
1. The question arrives. The agent saves it in the conversation.
2. **At the same time**, it: searches the web, searches the uploaded documents (if the
   question came with a document collection), and checks its notes about this user.
3. It **reads the top 3 web pages** in full (not just the preview text).
4. Everything it read gets a number: [1], [2], [3]… Only things it actually read get a
   number. That is the grader's #1 rule: every citation must point to something
   retrieved for *this* question.
5. It hands all that to Claude (the AI) and asks: answer using only these sources. Claude
   can ask to search or read more, up to **8 actions or 90 seconds**. After that it must
   answer with what it has, and the answer is honestly marked "cut short" (`cap`).
6. The answer streams back word by word. **The list of sources is sent before the first
   word**, so the website can show citation chips right away.
7. If Claude invents a citation number that doesn't exist, the code deletes it before it
   reaches the user.
8. A **receipt** (`runs/<id>.json`) is written: every step, success or failure, time,
   tokens and cost. The grader reads only these receipts.

**If something breaks** (search engine down, AI down), the user gets a real error
(code 502). It never makes up an answer to hide the problem. This is the
"fail loud" rule; breaking it is an automatic fail.

### Search memory (cache)
Web searches cost money. Each search result is saved for 6 hours (in memory and in the
database). Asking the same thing again reuses it. Measured: repeat questions cost about
$0.025 and start answering in about 1.5–2.2 seconds.

### Long-term memory
If the user states a lasting preference ("I prefer TypeScript"), Claude can choose to
save it. Every question first checks the saved notes for anything relevant (by meaning,
not exact words). Users can see every note (`GET /memory`) and delete any
(`DELETE /memory/<id>`). Nothing is remembered that the list doesn't show.

### Your own documents
1. **Upload**: the file is stored in the database and a "to-do" ticket is created.
   The user gets an instant "got it" (code 202) within 0.3 seconds. Nothing heavy
   happens during the upload itself (that's a graded rule).
2. **A separate helper program (the worker)** picks up the ticket and:
   - reads the file: PDFs page by page, Markdown section by section
   - cuts it into passages of about 150 words (slightly overlapping)
   - turns each passage into numbers that capture its meaning ("embeddings")
   - saves the passages
   - **double-checks** it can actually find one of them again before calling the
     document "indexed" (the database takes a moment to make new data searchable)
3. If the worker crashes halfway, a clean-up routine puts the ticket back in the queue,
   and finished steps are not redone.
4. **Searching documents** combines two searches, by meaning and by keywords, and
   ranks passages that score well on both highest. Citations show the file and page,
   e.g. `retrieval-basics.pdf, p. 2`.

Tested offline: for all 39 of the course's test questions, the answer text lands inside
one passage on the correct page.

---

## 5. Where things live (file map)

All in `backend/agent/src/`:

| File | What it does |
|---|---|
| `index.ts` | the "reception" of the agent: web addresses (routes), security checks, `/stats`, starts the worker |
| `ask.ts` | answering a question (the loop described above) |
| `search.ts` | web search, the search cache, reading web pages, picking the quote for each citation |
| `memory.ts` | saving / finding / listing / deleting memories |
| `embed.ts` | turning text into "meaning numbers" (OpenAI embeddings) |
| `docs.ts` | document collections ("Spaces"), uploads, document search |
| `parse.ts` | reading PDFs / Markdown / text and cutting them into passages |
| `worker.ts` | the background helper that processes uploads |
| `env.ts`, `db.ts` | settings and the database connection |

---

## 6. How to run and test it (on your own computer)

The agent needs the keys in a `.env` file at the project root (copy `.env.example`;
see §8). Then:

```bash
npm install
npm run dev:agent
```

In a second terminal (same folder), ask a question:

```bash
T=$(curl -s -X POST localhost:8000/threads -H 'x-user-id: dev' | node -pe 'JSON.parse(require("fs").readFileSync(0)).threadId')
curl -N -X POST localhost:8000/threads/$T/ask -H 'x-user-id: dev' -H 'content-type: application/json' -d '{"query":"What is a TTL index in MongoDB?","mode":"web"}'
```

Test document upload with one of the course files:

```bash
S=$(curl -s -X POST localhost:8000/spaces -H 'x-user-id: dev' -H 'content-type: application/json' -d '{"name":"test"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).spaceId')
curl -s -X POST localhost:8000/spaces/$S/documents -H 'x-user-id: dev' -F 'file=@eval/gold/corpus/retrieval-basics.pdf'
curl -s localhost:8000/spaces/$S/documents -H 'x-user-id: dev'
```

Repeat the last line until it says `"status":"indexed"`, then ask about it:

```bash
curl -N -X POST localhost:8000/threads/$T/ask -H 'x-user-id: dev' -H 'content-type: application/json' -d "{\"query\":\"What is the default k1 in BM25?\",\"mode\":\"docs\",\"spaceId\":\"$S\"}"
```

The grader's rule check: `node quality/check.mjs .` (the `P2` warning is about the
course's own rule file and can be ignored).

**Note for coding agents in cloud sandboxes:** a sandbox may not be able to reach
MongoDB Atlas, Tavily or OpenAI (only HTTPS to some hosts is allowed). In that case,
write the code there and have a person run the tests on their own machine.

---

## 7. Rules that must not be broken (automatic fails)

From `AGENTS.md`, in plain English:

1. **Never edit** `web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`,
   `scripts/`. They are the provided website, the rulebook and the grader.
2. **Never cite something that wasn't retrieved for that question.**
3. **Never hide an error behind a fake answer.** Errors become a 502.
4. **A "cut short" answer must say `cap`**, never `done`.
5. **Quick searches must never use the planning tool** (`plan_research`); only
   deep searches may.
6. **Never commit secrets** (keys, passwords). `.env` is already excluded from git.
7. **Never hand-edit the grader's report** (`report.json`).

---

## 8. Secrets and accounts

- The keys go in `.env` at the project root. Never commit it; never paste keys into
  code, issues or shared docs.
- **Each teammate should ideally use their own free accounts** (Anthropic, Tavily,
  OpenAI, MongoDB Atlas). A free Atlas cluster only allows 3 search indexes, and one
  copy of LUMINA uses all 3.
- Some keys were pasted in a chat during setup. **Replace them with new ones before
  deploying.**

---

## 9. What's next, in order

### A. Deep search (biggest remaining points)
When the user picks "Deep", the agent should:
1. **First** ask Claude to break the question into 3–6 smaller questions, each with a
   one-line reason, and send that plan to the user **before searching anything**
   (`plan` event). The plan must arrive within about 4 seconds.
2. Research each small question with the same tools as quick search. Every step and
   every source must be labeled with which small question it served (`subQuestion`).
3. Merge all sources into **one** numbered list (no duplicates, numbered from 1).
4. Write a structured answer: a direct answer, one section per small question, then
   "what is still unknown".
5. It must find **at least twice as many distinct sources** as a quick search of the
   same question. Longer text over the same pages fails.
6. Limits: 24 actions / 240 seconds, and **5 deep searches per user per day**, enforced
   in the agent (answer 429 with `resetsAt` when over). `/stats` already reports
   `deepToday` / `deepDailyCap`.

Where: `backend/agent/src/ask.ts`. Right now it answers `501` for `depth: "deep"`.
The run log must record `depth: "deep"`. Contract details: `packages/contract/src/sse.ts`
(`PlanEvent`, `SubQuestion`, `DEEP_ONLY_TOOLS`) and `SPEC.md` §5.5.

### B. The gateway (`backend/gateway/`)
Small. It must: allow the website's address (CORS); reject requests without an
`X-User-Id` (401); reuse or create a request ID and pass it on; log one line per request;
check request bodies against the rulebook's schemas (`packages/contract`); limit each
user to 30 requests per minute (429); pass the streamed answer through **without
buffering** (otherwise words arrive all at once); serve the website files and
`/evals/report.json`. See `TECHNICAL.md` Part 2.

### C. Try it in the browser
`npm run dev`, open http://localhost:5173, click everything. Then run
`node benchmark/bench.mjs` until it passes.

### D. Put it online, then run the grader
Agent on Fly.io (**private**: only the gateway may reach it), gateway on Fly.io
(public), website on Vercel. Then run `/fde-lumina-eval --deploy-url <gateway URL>`
in Claude Code, which runs the grader against the live site and writes the report shown
at `/evals`. Also needed: one deliberately failed run (turn off the search key, ask a
question, move that receipt into `runs/failing/`) and a 60–90 second video. Full steps:
`TECHNICAL.md` Part 4 and "Submit".

---

## 10. Things to keep an eye on

- **Speed of the first word on brand-new questions.** The target is under 2.5 seconds
  (95% of the time). Repeat questions already make it; new ones still need to search and
  read pages first, and haven't been measured since a startup fix. If the benchmark
  fails on this, the first thing to try is sending less page text to Claude (each page is
  currently cut at 6,000 characters in `search.ts`).
- **Answers are fairly long** (about 600–1,000 tokens, roughly 450–750 words). Shorter answers would be faster
  and cheaper.
- `benchmark/sla.json` lists placeholder prices but sits in a folder we must not edit.
  Our own cost numbers use the real published rates (set in `env.ts`). Ask the
  instructor if that matters.
