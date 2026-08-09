Architectural Blueprint: Robust Agent Loop for Local LLM Code AssistantsExecutive Summary & Architectural DiagnosisBuilding autonomous software engineering agents powered by small, open-weight local Large Language Models (LLMs)—such as Qwen 3.6 35B or Gemma 4 31B—requires a fundamentally different context management strategy than cloud-based API solutions. Standard single-phase agentic loops execute research, architectural planning, code modification, and terminal testing within a single continuous conversation thread. When applied to large enterprise codebases, this legacy pattern fails due to catastrophic token accumulation, quadratic scaling bottlenecks, and severe model context rot.Telemetry from single-phase execution logs reveals that prompt re-reading accounts for 88% to 96% of total token processing per run, with a read-to-write tool ratio exceeding 30:1. Because every step re-transmits full source files, intermediate search outputs, and tool logs back through the transformer, token processing scales quadratically $O(n^2)$ relative to step count $n$.Legacy Single-Phase Loop Token Growth:
Step 1:   Context Size ~12,000 tokens  --> Processing Overhead: Low
Step 15:  Context Size ~85,000 tokens  --> Processing Overhead: Moderate (TTFT Latency Spikes)
Step 40:  Context Size ~260,000 tokens --> Processing Overhead: Severe (TTFT > 15s, Context Rot)
In small open-weight models, this unconstrained history expansion causes three critical failure modes:Time-To-First-Token (TTFT) Latency Spikes: Self-attention computation scales quadratically $O(n^2)$ with input sequence length. Re-reading 200,000+ tokens per step exhausts local hardware throughput.Context Rot ("Lost-in-the-Middle"): Model attention degrades over long context sequences. Critical operational constraints and system invariants buried in historical tool logs are ignored.Reactive Guard Over-engineering: To control runaway execution loops, systems accumulate reactive runtime guards (e.g., StepBudget, ReadBudget, compactMessages, EmptyResultStreak). These guards address symptoms rather than the root cause: mixing research (discovery) and code writing (implementation) within a single memory context.This blueprint outlines a decoupled, two-phase (Gather/Apply) agent loop combined with deterministic Markdown context chunking, local hybrid RAG, and epoch-based state validation.Decoupled Two-Phase Execution Architecture (Gather & Apply)To eliminate quadratic context growth, the agent loop decouples discovery from execution. The node execution lifecycle is partitioned into two distinct phases connected by a schema-validated, structured handoff payload.1. Gather Phase (Discovery & Research)Objective: Explore the codebase, query vector and lexical indices, execute read-only tools, and construct a modification plan.Allowed Tools: Read-only workspace tools (read_file, grep, search_index), local RAG queries, and read-only Model Context Protocol (MCP) integrations.Context Bounds: Bounded by a strict step cap and a read token ceiling (e.g., 24,000 tokens).Transcript Lifespan: Ephemeral. The raw conversational history of the Gather phase is discarded immediately upon node completion.Output Artifact: A structured JSON payload called the NodeBrief generated via constrained decoding.2. Apply Phase (Deterministic Code Mutation)Objective: Modify target files based on the validated NodeBrief plan.Allowed Tools: Strictly write-only operations (write_file, apply_patch). No read tools, search tools, or external MCP calls are accessible.Context Bounds: Opens at a fixed, minimal frame (typically 3,000 to 6,000 tokens) containing only the Task Contract, Task Blackboard state, the NodeBrief, and the current contents of declared target write paths.Execution Footprint: Bounded $O(1)$ context scaling relative to research step history.Phase ParameterGather Phase (Discovery)Apply Phase (Mutation)Primary GoalUnderstand context, locate target files, form planExecute code changes deterministicallyTool PurityStrictly Read-Only ("pure")Strictly Write-OnlyContext InitializationContract + Master Index + RAG SnippetsFresh Context: Contract + NodeBrief + Target SourceContext HistoryShort-lived, discarded upon completionBounded $O(1)$ execution frame (3k–6k tokens)MCP AvailabilityAllowed (Gated, read-only external tools)Prohibited (Revoked during execution)The NodeBrief Handoff SchemaThe communication bridge between Gather and Apply is the schema-validated NodeBrief payload:TypeScriptinterface NodeBrief {
  /** High-level technical discoveries made during research. */
  findings: string[];
  
  /** List of workspace files identified as relevant, including rationale and epoch. */
  relevant: { 
    path: string; 
    why: string;
    epoch: number;
  }[];
  
  /** Specific structural changes planned per target write path. */
  plan: { 
    path: string; 
    change: string; 
  }[];
  
  /** Bounded retrieval snippets sourced via local RAG/vector index. */
  retrieval_snippets: {
    path: string;
    snippet: string;
    score: number;
    provenance: {
      byte_range: [number, number];
      epoch: number;
    };
  }[];
  
  /** Unresolved ambiguities or missing specifications that halt execution. */
  blockers: string[];
}
Small LLM Robustness: Multi-Stage Fallback ParserSmall open-weight LLMs can occasionally generate malformed JSON when processing near their context limits. To prevent node failure during handoff generation, the orchestrator implements a multi-stage fallback parser:Primary Stage (generateStructured): Constrained schema decoding via strict grammar forcing (Zod / JSON Schema).Secondary Stage (JSON Repair): If JSON syntax errors occur, run an automated string-repair library to fix trailing commas, unescaped quotes, or missing closing brackets.Tertiary Stage (Markdown Block Extraction): If structured generation fails entirely, parse the output text for Markdown header blocks (## Findings, ## Target Files, ## Plan) and map them programmatically into the NodeBrief interface.Deterministic Context Engine, Chunking Strategy & State InvariantsTo keep project information structured without stuffing full files into prompts, the codebase is formatted into deterministic Markdown context chunks managed by a Master Index.Context Directory LayoutContext artifacts reside within a dedicated directory at the workspace root:/.aca/context/├── index.md                # Master Context Index (< 2,000 tokens)├── meta.json               # Machine-readable metadata, SHA256 hashes, & epochs├── task_state.json         # Persistent Task Blackboard (multi-node continuity)├── chunk-00001.md          # ~8k tokens of Markdown context├── chunk-00002.md          # ~8k tokens of Markdown context└── chunk-00003.md          # ~8k tokens of Markdown contextDeterministic Chunking Algorithm & ConventionsToken Allocation: Chunks target ~7,500 to 8,000 tokens to leave sufficient headroom within local 16k–32k window configurations.Deterministic Ordering: Source files are walked in stable, lexicographically sorted path order.Semantic Partitioning: Splitting respects logical file and module boundaries before falling back to token boundaries.Frontmatter Standard: Every chunk includes standardized YAML metadata:id: chunk-00004.md
sha: a8f3c2149e891b...
epoch: 14
tokens: 7850
topics: ["database", "orm", "migrations", "users"]Database Schema and Migration ModelsSummaryDefines the User schema, authentication models, and pending database migrations.Key Source Filessrc/db/schema/users.ts — User table definition and indexes.src/db/migrations/004_auth.sql — SQL migration for authentication rules.Module Detail[Serialised representation of source interfaces and functions]Dual Master Index Schema (index.md)The Master Index is strictly capped under 2,000 tokens and provides dual human/machine formatting:Project Context IndexLast Updated: 2026-08-08T20:00:00ZTotal Chunks: 8 | Total Context Tokens: 62,400 | Active Epoch: 14Quick Mapchunk-00001.md — Core system architecture, configuration loaders (Tokens: 7,900)chunk-00004.md — Database schema, migration models, user ORM (Tokens: 7,850)chunk-00008.md — API endpoints, REST route handlers, middleware (Tokens: 7,600)json{"active_epoch": 14,"chunks": [{"id": "chunk-00001.md","summary": "Core system architecture, config loaders","tokens": 7900,"sha": "e3b0c442...","epoch": 14},{"id": "chunk-00004.md","summary": "Database schema, migration models, user ORM","tokens": 7850,"sha": "a8f3c214...","epoch": 14}]}
### State Validation Gates & Multi-Node Continuity

1. **Monotonic Epoch Counter**: An integer tracking workspace mutations. Bumps whenever workspace source files or chunks are altered.
2. **Pre-Apply Epoch Gate**: Before the Apply phase modifies target paths, the orchestrator verifies that `epoch` values declared in the `NodeBrief` match the Master Index. If a mismatch occurs, execution halts and triggers a re-gather sequence.
3. **Lazy Re-indexing**: Chunks are re-indexed asynchronously upon node execution completion or pre-commit gates rather than inline during individual write operations, preventing re-chunking cascades.
4. **Persistent Task Blackboard (`.aca/task_state.json`)**: To prevent context loss across sequential tasks (e.g., multi-node execution spanning 5–10 nodes), global project invariants, architectural decisions, and completed node summaries are appended to a persistent blackboard file passed into every Gather and Apply prompt [cite: 3, 6, 7].

---

## Gather-Phase Local RAG Subsystem

Retrieval-Augmented Generation (RAG) is integrated exclusively within the Gather phase to augment discovery without polluting the Apply context window.

                 +-----------------------------------+
| Gather Phase Intent / Query |+-----------------------------------+|v+-----------------------------------+| Hybrid Retrieval Engine || - Dense Vector k-NN (sqlite-vec) || - Sparse Lexical Match (grep) |+-----------------------------------+|v+-----------------------------------+| Provenanced Snippets || - Bounded 200-400 token passages || - Wrapped in <<<UNTRUSTED_DATA>>> |+-----------------------------------+|v+-----------------------------------+| Enriched NodeBrief Payload Output |+-----------------------------------+
### Technical Workflow for Local RAG

1. **Hybrid Retrieval**: Combines dense vector $k$-Nearest Neighbors ($k$-NN) retrieval with sparse lexical searching (`grep`) to capture both conceptual intent and exact symbol names.
2. **Snippet Extraction**: Slices retrieved files into bounded passages (200–400 tokens) accompanied by provenance metadata (file path, byte range, score, epoch).
3. **Context Fencing**: Snippets inside the `NodeBrief` are enclosed in security boundary tags:

```text
<<<UNTRUSTED_DATA>>>
Source: src/auth/jwt.ts (Bytes: 1024-1450 | Epoch: 14)
Snippet:
export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
}
<<<END_UNTRUSTED_DATA>>>
Safe Model Context Protocol (MCP) Client ArchitectureThe system acts as an MCP Client exclusively during the Gather phase. Confining MCP tools to Gather ensures third-party integrations cannot execute untracked side-effects on codebase files during generation.Architectural Safeguards for MCPPurity Restriction: Every imported MCP tool schema is forced to "pure" (read-only). Tools requesting write capabilities are rejected during startup.Namespace Isolation: MCP tool names are prefixed as mcp__<server_name>__<tool_name> to prevent collision with core system tools.Spill-to-Disk Threshold: If an MCP tool returns data exceeding 12,000 tokens, the payload spills to .aca/artifacts/ and returns an artifact pointer (read_artifact) to prevent prompt overflow.Graceful Degradation: If an external MCP server fails to launch within a timeout window (e.g., 10,000ms), the orchestrator logs a warning and proceeds without those tools.Recommended Technology Stack & Infrastructure MatrixTo host and execute this architecture locally, the following technology components are recommended:Component LayerPrimary TechnologySecondary AlternativeRole / Operational PurposeInference EnginevLLMOllama / LM StudioLocal serving with PagedAttention and continuous batching.Local Code ModelQwen 3.6 35BGemma 4 31BPrimary reasoning, tool call generation, and code mutation model.Local Vector DBsqlite-vecLanceDB / FAISSSQLite extension for file-backed local vector embedding search.Local Embedderbge-small-en-v1.5nomic-embed-text-v1.5Quantized, CPU-friendly embedding generation for code artifacts.MCP Runtime@modelcontextprotocol/sdkCustom Stdio TransportProtocol client for managing external MCP tools.Schema ValidationZodTypeBox / InstructorStrict schema definitions and grammar forcing for NodeBrief handoffs.Step-by-Step Implementation Roadmap & Verification BenchmarksRollout Sequencing Plan[ Stage 1: Core Handoff ] --> [ Stage 2: Empirical Benchmarks ] --> [ Stage 3: Guard Cleanup ]
|
[ Stage 5: Production Grants ] <-- [ Stage 4: MCP & Local RAG ] <-----------+
Stage 1: Core Handoff Infrastructure:Implement NodeBrief schema and TypeScript interfaces.Build two-phase executor behind the feature flag ENABLE_TWO_PHASE_LOOP.Enforce write-tool isolation in the Apply phase.Stage 2: Empirical Measurement Gate:Execute evaluation benchmarks across identical tasks.Verify that input token volume drops by $\ge 75\%$ and TTFT decreases without reducing task completion rates.Stage 3: Legacy Guard Deprecation:Deprecate single-phase runtime guards (ReadBudget, lowStepsNotice, compactMessages, EmptyResultStreak, seenCalls).Retain global token ceiling (spentByNode) and provider truncation retries.Stage 4: Context Engine, MCP & Local RAG Integration:Implement deterministic chunker, index.md generator, and .aca/task_state.json blackboard.Deploy stdio MCP client and local sqlite-vec embedding store.Stage 5: Persona Grant System & Production Default:Assign read-only MCP and RAG permissions to Gather personas (planner, coder, reviewer).Enable the two-phase loop architecture by default.Target Performance MetricsPerformance IndicatorLegacy Single-Phase BaselineRedesigned Two-Phase TargetVerification BenchmarkInput Tokens / Step180,000–370,000 tokens3,000–6,000 tokens (Apply Phase)$>90\%$ reduction in input processing wasteTime-To-First-Token (TTFT)$>12.0\text{s}$ (Local GPU)$<1.5\text{s}$ (Local GPU)Sub-second execution responsivenessRead-to-Write Ratio$\approx 30:1$[cite: 1]$< 5:1$[cite: 1]Structured, bounded research explorationSyntax/Type Error RateModerate/High (Context rot)Minimal (High signal-to-noise ratio)Zero structural code generation failuresRecovery Invalidation CostFull conversation re-evaluationFast re-gather via epoch gate fail-fastSub-second state failure recovery



