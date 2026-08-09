Implement RAG as part of the Gather phase only, producing an enriched NodeBrief that includes retrieved passages, embedding-match metadata, and provenance. Keep Apply strictly write-only and limited to the contract + NodeBrief + target file contents. This preserves the safety model described in the document while giving small local models access to a large project’s context.

Why this fits the Loop redesign
The document’s core change is the gather/apply split and the NodeBrief handoff; RAG naturally augments gather because gather is read-only and already allowed to call MCP/read tools. Embedding-based retrieval is a read operation and therefore safe to confine to gather.

Apply must start from a fresh, bounded context; adding retrieval into apply would reintroduce the research/write conflation the redesign removes. The document explicitly warns that third-party tools that write must be excluded from apply; similarly, retrieval must not enable hidden external writes.

What to store in the NodeBrief (RAG-enhanced)
findings: short natural-language summary of what the gather phase learned (bounded).

relevant: list of retrieved items with one-line why, score, and provenance (file path, byte range, commit/epoch, retrieval timestamp).

plan: intended changes per path.

retrieval_snippets: up to N short passages (e.g., 3–5) per relevant file, each with embedding score and pointer to artifact (artifact id or path).

blockers: anything unresolved.

Keep every field size-bounded and schema-validated (NodeBrief already uses generateStructured).

Implementation plan (practical steps)
1 — Indexing and embedding store
Local vector DB: pick a lightweight local vector store (e.g., FAISS, SQLite+vector extension, or a tiny embedded store).

Embedding model: use a compact local embedder (quantized or CPU-friendly) to produce document vectors on file changes.

Indexing policy: index file contents, important artifacts, and commit-level snapshots. Include metadata: path, epoch, commit hash, byte offsets, and last-modified epoch.

2 — Gather: retrieval workflow
Trigger: gather decides which files/areas to search (contract + T2/T3 deltas + explicit file list).

Querying: produce an embedding for the gather prompt (or the node’s intent) and run k-NN against the local index.

Filtering: apply epoch/permission filters so gather only sees artifacts it’s allowed to read.

Snippet extraction: return short passages (e.g., 200–400 tokens) with provenance and embedding score.

NodeBrief enrichment: include retrieval_snippets and relevant entries in the NodeBrief. Validate size and schema.

3 — Apply: strict use of NodeBrief
No reads from vector DB in apply. Apply may read the current contents of files it will write (to avoid races), but it must not perform broad discovery.

Gates: before any write, gates verify that the NodeBrief’s declared relevant files and plan match the actual files and epochs; if mismatch, fail the node with blockers.

Provenance checks: gates should ensure that any snippet used to justify a change is still current (epoch check) or else require a gather retry.

4 — Index freshness and invalidation
On write: when a node’s write is accepted, update the index for affected files and bump epochs.

Epoch-aware retrieval: retrieval results must include epoch; gather should prefer same-epoch artifacts or mark older ones as potentially stale.

Re-gather policy: if apply detects a mismatch (file changed since gather), it should fail and schedule a re-gather rather than silently proceed.

5 — Budgeting and limits
Read budget: count embedding queries and returned snippet tokens against the gather read budget. Large retrievals should spill to artifacts (as the document already handles oversized MCP output).

Snippet caps: limit number of snippets and tokens per snippet to keep NodeBrief small (e.g., 3 snippets × 300 tokens).

Fallback: if gather cannot produce a valid NodeBrief within budget, fail early with blockers.

6 — Safety and permissions
Persona permissions: grant RAG retrieval to gather personas only (planner/coder/reviewer) per the document’s permission model.

Untrusted data marking: mark retrieval snippets as untrusted (the document’s <<<UNTRUSTED_DATA>>> pattern) so apply and gates treat them as evidence, not authoritative truth.

Audit trail: store retrieval queries and results as artifacts for later inspection and debugging.

Failure modes and mitigations
Missed documents: gather might not retrieve a needed file. Mitigate by: (a) making NodeBrief include relevant file paths the gather read; (b) gating apply to require those files be present; (c) re-gather on failure.

Stale snippets: apply writes based on stale snippets. Mitigate with epoch checks and fail-fast re-gather.

Index bloat / cost: large projects produce large indexes. Mitigate with sharding, per-directory indices, and LRU pruning of old artifact snapshots.

Embedding quality: small embedder may miss semantic matches. Mitigate by combining lexical filters (grep) with embedding retrieval in gather.

Minimal prototype to validate
Add a local vector store and an embedding step that runs on file save/commit.

Modify gather to: (a) call the embedder with the node intent, (b) retrieve top-k snippets, (c) produce an enriched NodeBrief.

Run A/B measurement (per document stage 2): compare token counts, steps to first write, completion rate between current loop and two-phase loop with RAG in gather.

Gate tests: ensure apply fails when NodeBrief is stale or missing files.

Iterate: tune snippet sizes, k, and budgets.

Short checklist to add to your sequencing (fits doc’s Stage list)
Stage 1 variant: implement NodeBrief schema additions for retrieval_snippets and provenance.

Stage 2 measurement: run the two-phase loop with RAG-on-gather vs. two-phase without RAG. Measure input tokens per node and steps to first write.

Stage 3: remove redundant guards only after measurements confirm improvements.

Stage 4: integrate local vector DB and embedder; keep MCP client unchanged (MCP remains gather-only).

Stage 5: permission review and persona grants for retrieval tools.

Final notes
RAG belongs in gather: it’s read-only, fits the safety model, and produces a compact, schema-validated NodeBrief that small models can use to act on large codebases without re-reading everything.

Keep the NodeBrief bounded and epoch-aware so apply remains cheap and deterministic.

Measure early: the document emphasizes measurement as a gate — validate that RAG reduces input tokens and steps for your small local model before rolling it out.