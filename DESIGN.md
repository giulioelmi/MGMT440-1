# DESIGN.md — LUMINA

## Components

I think of LUMINA as four running pieces: the browser UI hosted on Vercel, the public gateway on Fly, the private agent service on Fly, and the document worker running as a second Node process alongside the agent deployment. The worker uses the same package, which keeps deployment simpler while letting indexing happen separately from answering questions. I would also draw Atlas for storage and Anthropic, Tavily and OpenAI for answers, search and embeddings. Some important parts are stored state rather than running programs: the jobs collection tells the worker what needs processing, the search cache holds reusable results, run logs record what happened, and the deep usage counter determines whether another deep search is allowed.

## Responsibilities

I keep provider keys within the agent side of the system, including the worker's embedding work. Giving the gateway provider keys would create another place that could call paid services and bypass the agent's controls. The gateway handles admission checks, including request validation and rate limits, while the agent enforces the daily deep-search cap where spending actually happens. That split lets the gateway reject excessive traffic early and keeps the spending rule attached to execution. The browser only talks to the gateway; it cannot call the agent, database or providers directly, hold provider keys, or decide that an uploaded document is searchable.

## Communication

I use HTTP between the browser, gateway and agent, with SSE to stream answer events back through the gateway. SSE fits because the answer flows in one direction, without needing a WebSocket connection or repeated polling for new tokens. Uploads take a different path: the upload route stores the file, inserts a pending job in Atlas and returns 202 so the browser can show that processing is underway. The worker claims that job later, so the upload request does not have to wait for parsing and embedding. In my failed-search test, Tavily's invalid-key response caused a 502 before Claude ran. The client received the provider's error message and a request ID, but never the key itself; my curl command simply discarded the response body.

## State

I use Atlas as the source of truth for conversations, memories, uploaded files, document status and active jobs. The search cache can be deleted without losing original data, while chunks and embeddings can be rebuilt from the uploaded files. I would still treat run logs as real diagnostic history and the deep usage counter as authoritative, because deleting them would remove evidence or reset someone's allowance. After a PDF is uploaded, the user sees its processing status until the worker finishes and confirms that a chunk can actually be retrieved through the vector index. Only then does it become indexed and searchable. Memories live separately from conversation history, are filtered by user ID, and reach a new conversation through `recall_memory`, so starting a new thread does not erase saved preferences.

## Trade-offs

I accepted quick TTFT of about 4.2 seconds against the 2.5-second target for now because I wanted to preserve source quality, although I am not yet sure that rules out Tavily's faster search; I would compare latency and citation quality on the same questions before deciding. I use Haiku for deep planning and Sonnet for the answer to get the plan out sooner, but a weak plan can still send the research in the wrong direction, and I have only judged that quality by reading examples. Limiting quick mode to one search reduced extra latency, cost and cache misses, at the expense of recovering when the first results miss the question. Finally, I would prefer a generic provider-failure message with the request ID in the client response and full details in the logs. The current response helped me diagnose the test, but users do not need the raw provider message to understand that the search failed.
