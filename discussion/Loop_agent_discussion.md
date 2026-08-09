Summary of approach (what you'll get)
A practical design and implementation plan to keep project context in 8k‑token Markdown chunks, with an index file, MCP‑based read/write tooling, and an orchestrator that directs the agent to load only the relevant chunks. Includes schema suggestions, read/write rules, gating, and examples of prompts and file layouts you can drop into your two‑phase loop (gather / apply).

Key principles (short)
Chunk, index, and fetch: split context into fixed‑size Markdown chunks (≈8k tokens), maintain a small index that maps topics → chunk IDs and short summaries, and fetch only the chunks the node needs.

Gather-only MCP reads: use MCP tools in the gather phase to read chunks and update the index; apply never reads MCP tools.

Structured NodeBrief: the gather phase returns a NodeBrief that lists chunk IDs read and the short findings; apply uses only the brief + target file contents.

Deterministic chunking and metadata: chunk IDs, checksums, and epochs let you detect staleness and avoid re-reading unchanged chunks.

Markdown-first: store chunks as Markdown with a fixed frontmatter schema so models can parse meaningfully.

Recommended file layout and naming
Use a dedicated context directory in the repo or artifacts store.

Code
/.aca/context/
  index.md                # master index (small, < 2k tokens)
  chunk-00001.md          # ~8k tokens of Markdown context
  chunk-00002.md
  ...
  meta.json               # machine-readable metadata for index (optional)
Chunk filename pattern: chunk-<zero-padded-seq>.md or chunk-<sha256prefix>.md. Use sequence for append-only history, hash for content-addressed deduping.

Index file shape (human + machine)
index.md is the canonical place the model checks first. Keep it tiny and human-readable; also include a compact JSON block for tooling.

Example index.md top:

markdown
# Project Context Index

Last updated: 2026-08-08T20:00:00Z
Chunks: 12
Total tokens: 92,000

## Quick map
- chunk-00001.md — "project overview; architecture; goals" — tokens: 7,900
- chunk-00002.md — "data model; DB schema" — tokens: 7,850
- chunk-00007.md — "build & CI; scripts" — tokens: 7,600

```json
{"chunks":[{"id":"chunk-00001.md","summary":"project overview; arch; goals","tokens":7900,"sha":"...","epoch":12}, ...]}
Code

**Why both Markdown + JSON**: humans read the top; the orchestrator and MCP tools parse the JSON block to decide which chunks to fetch.

---

## Chunk content conventions (Markdown)
Each chunk should follow a small frontmatter and sections so the model can quickly find relevant parts.

```markdown
---
id: chunk-00007.md
sha: <sha256>
epoch: 12
tokens: 7600
topics: ["ci","build","docker","scripts"]
---

# Build and CI

## Summary
One-paragraph summary (2–4 sentences).

## Important files
- `.github/workflows/ci.yml` — reason why it's relevant

## Details
Longer Markdown content, code blocks, tables, links.

## Change log
- 2026-08-01: updated dockerfile for caching
Frontmatter fields: id, sha, epoch, tokens, topics, last_modified.

Chunking strategy
Token target: aim for ~7.5–8k tokens per chunk to leave headroom for prompt framing.

Semantic boundaries: split at logical boundaries (files, modules, features) when possible; otherwise split by token count.

Deterministic algorithm:

Walk files in a stable order (e.g., repo tree sorted).

Serialize file metadata + content into Markdown sections.

Accumulate tokens until threshold reached → emit chunk.

Compute SHA and epoch for each chunk.

Rechunk on change: when files change, recompute affected chunks and bump epochs; avoid rewriting unchanged chunks.

Index maintenance and epochs
Epoch: integer that increments when any chunk content changes. Stored per chunk in index.

Checksum (sha): content hash to detect identical content and avoid unnecessary reads.

Index update rules:

Only gather phase MCP tools update the index.

Index updates are atomic: write new chunk(s) then update index with new epoch and checksums.

Keep index small (<2k tokens) so it can be read cheaply.

Orchestrator / Loop behavior (integrates with your two‑phase design)
Gather phase (read-only, MCP allowed)
Step 1 — Read index.md via MCP read tool.

Step 2 — Decide relevant chunks:

Use Node contract + T2 deltas + T3 chunks to produce a short query (1–3 sentences) for relevance.

Run an MCP tool that scores index entries by relevance (e.g., mcp__fetch__searchIndex).

MCP returns a ranked list of chunk IDs and short excerpts.

Step 3 — Fetch top N chunks (bounded by read budget). N chosen so total tokens ≤ gather read cap (e.g., 24k tokens).

Step 4 — Produce NodeBrief:

findings: short bullet points extracted from fetched chunks.

relevant: list of chunk IDs with one-line why.

plan: what files to change.

blockers: missing info or ambiguous items.

Important: gather must include the index and chunk IDs in the NodeBrief so apply can fetch file contents only for declared write targets.

Apply phase (write-only)
Input: contract + NodeBrief + current contents of files to be written.

No reads: apply cannot call MCP read tools; it only writes declared files.

Validation: gates verify that apply only modified declared files and that changes are consistent with NodeBrief.

MCP tools to implement
Place these in packages/tools/src/mcp/ as you sketched, but with these specific endpoints:

mcp__context__readIndex — returns parsed index JSON and a tiny summary.

mcp__context__searchIndex — accepts a short query and returns ranked chunk IDs + excerpts + token counts.

mcp__context__fetchChunks — accepts list of chunk IDs and returns chunk Markdown (or artifact refs if large).

mcp__context__writeChunks — write new chunk files and return new checksums/epochs (used only by gather).

mcp__context__rechunk — optional: recompute chunk boundaries for changed files.

Security & purity: mark these MCP tools as pure/read-only for gather; writeChunks is allowed only under a controlled persona and must be gated.

Read budget and fetch policy
Index read is free (very cheap) and always done first.

Budgeted fetch: set a per-node gather read token cap (e.g., 24k tokens). The orchestrator sums token counts from index entries before fetching.

Progressive fetch: fetch top‑ranked chunks first; if NodeBrief indicates missing info, allow a single retry to fetch more (still within budget).

Artifact spill: if a chunk is > artifact threshold, store it as an artifact and fetch via read_artifact (as you already do).

Prompting patterns and NodeBrief usage
Index-first prompt (gather): give the model the index JSON and ask for top 3 chunk IDs relevant to the task, with 1–2 sentence justification each.

Chunk summarization: ask the model to produce a 2–4 sentence summary per chunk and extract 3–5 facts (these become findings).

Apply prompt: include only the NodeBrief and the exact file contents to be modified; include a short instruction: “You may not read any other files; produce the new content for these paths.”

Example NodeBrief (concrete)
ts
{
  findings: [
    "DB schema v3 uses users.email as unique key; migration pending",
    "CI caches docker layers using /cache; build time reduced 40%"
  ],
  relevant: [
    { path: "chunk-00002.md", why: "DB schema and migrations" },
    { path: "chunk-00007.md", why: "CI and build scripts" }
  ],
  plan: [
    { path: "migrations/20260808_add_email_index.ts", change: "add unique index on users.email" }
  ],
  blockers: []
}
Consistency, gating, and recovery
Pre-write gate: if blockers non-empty, fail node before apply.

Epoch check: before apply writes, verify chunk epochs in NodeBrief match index; if mismatch, fail and require re-gather.

Atomic write sequence: gather writes new chunks (if any) and index update first; apply writes declared files next. Use checkpointing to rollback on gate failure.

Truncation & retry: if apply output truncated, gate should detect incomplete writes and trigger a retry with the same NodeBrief.

Operational notes and tradeoffs
Extra model calls: gather + apply adds calls, but reduces quadratic token growth and removes many guards.

Index staleness: epochs + checksums mitigate stale reads; require re-gather when index changed.

Large chunk outputs: MCP tools can spill to artifacts; orchestrator must account for artifact read costs.

Search quality: the index search can be simple (keyword + topic match) or use an embedding service for semantic search; embeddings add infra complexity but improve relevance.

When to re-chunk: schedule re-chunking on major merges or when chunk token counts drift beyond thresholds.

Short implementation checklist
Index schema (index.md + JSON block) and chunk frontmatter spec.

Chunking tool: deterministic chunker that outputs chunk files + meta.

MCP tools: readIndex, searchIndex, fetchChunks, writeChunks.

Orchestrator changes: implement gather steps (index → search → fetch → NodeBrief) and apply rules (no reads).

Gates: epoch checks, blockers, atomic index updates.

Measure: instrument token counts and steps per node; compare old loop vs two‑phase with chunking.

Permissions: grant MCP context tools only to gather personas.

Example prompts (templates)
Gather — index search

Code
You are the gather persona. Here is the project index JSON: <index-json>.
Task: <one-sentence task description>.
Return: top 3 chunk IDs relevant, each with a one-line reason and estimated tokens.
Gather — fetch & summarize

Code
You are the gather persona. You have fetched chunk-00002.md and chunk-00007.md.
For each chunk, produce:
- 2–4 sentence summary
- 3 facts relevant to the task
Return NodeBrief JSON with findings, relevant, plan, blockers.
Apply

Code
You are the apply persona. Input: contract, NodeBrief, and current contents of files to change.
Do not read any other files. Produce new content for the declared paths only.