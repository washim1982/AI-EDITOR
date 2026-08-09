Architecture Requirements — Robust Two‑Phase Loop with Hybrid RAG (Final)
Quoted from the project documents:  
"Split the node into a gather phase and an apply phase, with a structured handoff between them instead of a shared transcript."   
"Retrieval-Augmented Generation (RAG) is integrated exclusively within the Gather phase to augment discovery without polluting the Apply context window."

Purpose
Define a concise, implementable set of architecture requirements for the Loop redesign so small local models can work on large projects without losing context. These requirements codify the two‑phase execution model, hybrid RAG integration, deterministic chunking and indexing, epoch validation, gating, and safety constraints for third‑party MCP tools.

Scope
Applies to the agent node execution lifecycle (per‑node Gather → Apply).

Covers local hybrid RAG, local vector index, NodeBrief schema, epoch gates, lazy re‑indexing, MCP client constraints, and telemetry/measurement gates.

Excludes model selection/tuning, provider infra, and non‑agent CI/CD processes.

High‑level Requirements
1. Two‑Phase Execution
R1.1 Gather / Apply split: Every node must execute as two distinct phases: Gather (read‑only) then Apply (write‑only). No shared conversational transcript is carried from Gather into Apply.

R1.2 Fresh Apply context: Apply must open with a bounded context consisting only of: Task Contract, NodeBrief, Task Blackboard snapshot, and the current contents of declared target write paths. Target file contents are read at Apply start only.

R1.3 Minimum calls per node: Each node must perform at least two model calls (Gather → Apply). This is acceptable; measurement gate will validate net cost savings.

2. NodeBrief Schema and Handoff
R2.1 Schema‑validated NodeBrief: Gather must produce a schema‑validated NodeBrief (Zod/JSON Schema). If validation fails, the node fails with blockers.

R2.2 NodeBrief fields (required):

findings: string[] — bounded natural‑language discoveries.

relevant: { path: string; why: string; epoch: number; sha?: string }[] — files read and why.

plan: { path: string; change: string }[] — intended modifications per write path.

retrieval_snippets: { path: string; snippet: string; score: number; provenance: { byte_range: [number, number]; epoch: number; sha?: string; artifact_id?: string } }[] — bounded evidence from RAG.

blockers: string[] — unresolved items that must halt Apply.

R2.3 Bounded size: NodeBrief must be strictly size‑bounded (configurable defaults: total NodeBrief ≤ 2,048 tokens; retrieval_snippets total ≤ 1,200 tokens).

R2.4 Multi‑stage fallback: Implement generateStructured → JSON repair → Markdown extraction fallback for NodeBrief generation.

3. Gather Phase: Read‑Only Discovery + Hybrid RAG
R3.1 Read‑only tools only: Gather may call read_file, grep, read_artifact, and MCP (pure) tools; it may query the local vector index. No write tools allowed.

R3.2 Hybrid retrieval engine: Combine dense vector k‑NN and lexical matching (grep/BM25). Retrieval must return top‑k candidates, re‑ranked by combined score.

R3.3 Snippet extraction & provenance: Snippets must be 200–400 tokens each, include byte ranges, epoch, SHA, and optional artifact pointer if spilled. Wrap snippets in <<<UNTRUSTED_DATA>>> markers in any human/model visible text.

R3.4 Read budget & step cap: Gather must be bounded by a configurable read token ceiling and step cap (example starting values: 24,000 tokens, 200 steps). Retrieval costs and returned snippet tokens count against the read budget.

R3.5 Permissions: RAG and MCP access must be persona‑gated; default deny for MCP and RAG; grant only to Gather personas (planner/coder/reviewer).

4. Apply Phase: Deterministic Mutation
R4.1 Write‑only tools only: Apply may call write_file, apply_patch, and other write tools. No read tools, no MCP calls, and no vector queries.

R4.2 Fresh context size: Apply context must be small and bounded (recommended 3k–6k tokens).

R4.3 Pre‑apply epoch gate: Before any write, verify NodeBrief relevant epochs and SHAs against the Master Index. If mismatch, fail fast with blockers and schedule re‑gather.

R4.4 Target file read at start: Apply may read the current contents of declared target write paths at start to avoid blind writes; these reads are limited to declared targets only.

R4.5 No hidden discovery: If Apply needs additional files not declared in NodeBrief, it must fail rather than discover them.

5. Context Engine, Chunking, and Indexing
R5.1 Deterministic chunking: Source files must be converted to deterministic Markdown chunks (~7.5–8k tokens per chunk) with YAML frontmatter including id, sha, epoch, tokens, topics.

R5.2 Master Index: Maintain index.md under 2,000 tokens summarizing chunks, active epoch, and quick map.

R5.3 Persistent Task Blackboard: Maintain .aca/task_state.json to record multi‑node continuity, global invariants, and completed node summaries; inject into Gather and Apply prompts.

R5.4 Local vector DB: Use a local, file‑backed vector store (sqlite‑vec, FAISS, LanceDB) with a compact embedder. Index metadata must include path, chunk id, byte ranges, epoch, and SHA.

R5.5 Lazy re‑indexing: On writes, bump epochs immediately; defer full re‑chunking and re‑embedding until node completion or on‑demand pre‑gather. Provide a background re‑indexing worker.

6. MCP Client Constraints
R6.1 MCP only in Gather: MCP client integrations are allowed only during Gather. MCP tools must be forced to purity: "pure" and tier: "t0".

R6.2 Namespacing & validation: Map MCP tools to mcp__<server>__<tool> names; validate tool JSON Schema to zod before calls. Reject tools that request write capabilities.

R6.3 Spill threshold: If MCP or retrieval returns >12,000 tokens, spill to .aca/artifacts/ and return artifact pointer in NodeBrief.

R6.4 Startup timeout: MCP servers that fail to start within configured timeout (e.g., 10,000ms) are skipped with a warning.

7. Epochs, Gates, and Failure Modes
R7.1 Monotonic epoch counter: Maintain a workspace epoch integer that increments on any write affecting chunks or index.

R7.2 Pre‑apply verification: Apply must verify NodeBrief epochs against Master Index; mismatches cause immediate re‑gather.

R7.3 Blocker semantics: If NodeBrief contains blockers, the node must not attempt writes; return failure with blockers reasons.

R7.4 Re‑gather policy: On epoch mismatch or missing files, schedule a re‑gather rather than attempting merges in Apply.

R7.5 Audit trail: Persist retrieval queries, NodeBriefs, and gate decisions as artifacts for debugging and telemetry.

8. Budgets, Limits, and Defaults
R8.1 Default budgets (tunable):

Gather read token ceiling: 24,000 tokens (start).

NodeBrief total size: ≤ 2,048 tokens.

Retrieval snippets total: ≤ 1,200 tokens.

Apply context: 3,000–6,000 tokens.

MCP spill threshold: 12,000 tokens.

R8.2 Snippet caps: Max 3–5 snippets per NodeBrief; each 200–400 tokens.

R8.3 k selection: Dense k initial = 10; re‑rank and reduce to top 3 snippets.

9. Telemetry and Measurement Gate
R9.1 Stage 2 empirical gate: Before removing legacy guards, measure two‑phase loop with and without RAG. Required metrics: input tokens per node, steps to first write, completion rate, TTFT. Target: ≥ 75% reduction in input tokens per node and TTFT < 1.5s on local GPU for Apply.

R9.2 Telemetry: Record retrieval hit rates, re‑gather frequency, NodeBrief blocker reasons, apply failures, and index backlog.

R9.3 Guard removal policy: Only deprecate legacy guards (ReadBudget, lowStepsNotice, compactMessages, EmptyResultStreak, seenCalls) after empirical gate passes.

10. Security, Safety, and Permissions
R10.1 Persona grants: RAG and MCP read permissions must be granted only to Gather personas. Apply personas must have no read or MCP permissions.

R10.2 Untrusted data marking: All external retrievals and MCP outputs must be wrapped with <<<UNTRUSTED_DATA>>> markers and treated as evidence, not authoritative.

R10.3 Forgery detection: Tool results must include forgery detection metadata; treat MCP results as untrusted and validate via OutputGuard.

R10.4 Audit & review: Provide human‑reviewable artifacts for any node that modifies critical files or when NodeBrief contains high‑impact changes.

Operational Requirements
A. Implementation Roadmap (staged)
Stage 1: Implement NodeBrief schema, multi‑stage fallback parser, and two‑phase executor behind ENABLE_TWO_PHASE_LOOP flag. Enforce Apply write isolation.

Stage 2 (Gate): Run A/B measurements (two‑phase w/o RAG vs two‑phase w/ RAG). Validate token and latency targets.

Stage 3: Remove legacy guards only after Stage 2 success. Retain spentByNode and truncation retry.

Stage 4: Implement deterministic chunker, Master Index, lazy re‑indexing, local vector DB, embedder, and MCP client (stdio). Integrate hybrid RAG into Gather.

Stage 5: Persona grants, production enablement, monitoring, and index sharding/pruning.

B. Testing & Validation
Unit tests for NodeBrief schema and fallback parser.

Integration tests for Gather → NodeBrief → Apply with epoch mismatch scenarios.

Load tests on representative repos to measure token counts and TTFT.

Security tests to ensure MCP tools cannot write and that <<<UNTRUSTED_DATA>>> is enforced.

C. Monitoring & Alerts
Alerts for high re‑gather frequency, index backlog growth, or Apply epoch mismatches > threshold.

Dashboards: input tokens per node, TTFT, retrieval hit rate, NodeBrief failure reasons.

Data Formats and Example NodeBrief (final)
ts
interface NodeBrief {
  findings: string[];
  relevant: { path: string; why: string; epoch: number; sha?: string }[];
  plan: { path: string; change: string }[];
  retrieval_snippets: {
    path: string;
    snippet: string;           // bounded to N tokens
    score: number;             // combined dense+lexical score
    provenance: {
      byte_range: [number, number];
      epoch: number;
      sha?: string;
      artifact_id?: string;
    };
  }[];
  blockers: string[];
}
Failure Modes and Mitigations (summary)
Missed documents at Gather: Mitigate with hybrid retrieval (dense + lexical), explicit relevant file listing, and re‑gather on failure.

Stale snippets: Mitigate with epoch checks and pre‑apply gate; fail fast and re‑gather.

Index churn: Mitigate with lazy re‑indexing and background workers; provide epoch bumping on write.

Embedding misses: Mitigate by combining lexical grep and tuning embedder; expose config knobs for k and snippet caps.

Configuration Defaults (suggested)
GATHER_READ_TOKEN_CEILING = 24000

NODEBRIEF_MAX_TOKENS = 2048

RETRIEVAL_SNIPPETS_MAX_TOKENS = 1200

APPLY_CONTEXT_TOKENS = 3000 (min) to 6000 (max)

MCP_SPILL_THRESHOLD = 12000

EMBED_K = 10 (dense), final snippets = 3

Acceptance Criteria
AC1: Gather produces a schema‑valid NodeBrief for ≥ 95% of successful nodes; fallback parser handles the rest.

AC2: Apply never reads broad workspace context; only declared targets are read at start.

AC3: Stage 2 measurement shows ≥ 75% reduction in input tokens per node and TTFT reduction consistent with targets.

AC4: MCP tools are only available to Gather and are forced read‑only; any MCP tool requesting write capability is rejected.

AC5: Pre‑apply epoch gate prevents writes against stale state; re‑gather is triggered on mismatch.





Flow diagram 

flowchart TD
  %% Inputs and persistent state
  subgraph Workspace["Workspace / Persistent State"]
    Contract[/"Task Contract\n(.aca/contract)"/]
    Blackboard[/"Task Blackboard\n(.aca/task_state.json)"/]
    MasterIndex[/"Master Index\n(.aca/context/index.md)"/]
    Chunks[/"Chunks\n(.aca/context/chunk-*.md)"/]
    VectorDB[/"Local Vector DB\n(sqlite-vec / FAISS)"/]
    Artifacts[/"Artifacts\n(.aca/artifacts/)"/]
    EpochCounter[(Epoch Counter)]
  end

  %% Gather phase
  subgraph GatherPhase["GATHER (Read‑Only)"]
    GModel["Gather Model\n(small local LLM)"]
    ReadTools["Read Tools\nread_file, grep, read_artifact"]
    MCPClient["MCP Client\n(pure, namespaced)"]
    HybridRAG["Hybrid RAG\nembedder + kNN + grep/BM25"]
    SnippetExtractor["Snippet Extractor\n200–400 token snippets"]
    NodeBriefGen["NodeBrief Generator\ngenerateStructured + fallbacks"]
  end

  %% Handoff and gates
  NodeBrief["NodeBrief\n(schema-validated)"]
  EpochGate["Epoch Validation Gate\nverify epochs/SHAs"]

  %% Apply phase
  subgraph ApplyPhase["APPLY (Write‑Only)"]
    ApplyModel["Apply Model\n(small local LLM)"]
    TargetRead["Read Target Files\n(declared paths only)"]
    WriteTools["Write Tools\nwrite_file, apply_patch"]
    LazyReindex["Lazy Re-index Worker\nbackground"]
  end

  %% Telemetry & Monitoring
  Telemetry[/"Telemetry & Audit\nretrieval logs, NodeBriefs, gates"/]

  %% Flows: Workspace -> Gather
  Contract --> GModel
  Blackboard --> GModel
  MasterIndex --> GModel
  Chunks --> HybridRAG
  VectorDB --> HybridRAG
  ReadTools --> GModel
  MCPClient --> GModel
  HybridRAG --> SnippetExtractor
  SnippetExtractor --> NodeBriefGen
  GModel --> NodeBriefGen
  NodeBriefGen --> NodeBrief

  %% NodeBrief -> Gate -> Apply
  NodeBrief --> EpochGate
  EpochCounter --> EpochGate
  MasterIndex --> EpochGate
  EpochGate -- pass --> ApplyModel
  EpochGate -- fail --> GModel["Re-gather Trigger\n(fail-fast)"]

  %% Apply flows
  ApplyModel --> TargetRead
  TargetRead --> ApplyModel
  ApplyModel --> WriteTools
  WriteTools --> Chunks
  WriteTools --> MasterIndex
  WriteTools --> EpochCounter
  WriteTools --> Artifacts
  WriteTools --> Telemetry

  %% Lazy reindex and vector DB update
  WriteTools --> LazyReindex
  LazyReindex --> VectorDB
  LazyReindex --> MasterIndex
  LazyReindex --> Chunks

  %% Artifacts and telemetry
  MCPClient --> Artifacts
  HybridRAG --> Artifacts
  NodeBrief --> Telemetry
  EpochGate --> Telemetry
  GModel --> Telemetry
  ApplyModel --> Telemetry
