Architectural Review: Two-Phase Agent Loop for Local LLM Code Assistants
Executive Assessment
This is a well-architected proposal that addresses a genuine pain point in local LLM agent deployment. The decoupling of research from execution is the right architectural move, and the emphasis on deterministic state management demonstrates mature systems thinking.

However, I've identified several critical gaps and areas requiring hardening before this can be considered production-ready.

🔴 Critical Issues
1. Apply Phase Blindness Creates a "Blind Mutation" Problem
The Apply phase is described as "strictly write-only" with no read tools. This is dangerously brittle. Consider:

typescript
// NodeBrief plan says: "Update function signature in src/auth/jwt.ts"
// But between Gather and Apply:
// - A different node modified the same file 
// - The target function was renamed
// - The line numbers shifted
// - Import dependencies changed
Recommendation: Grant the Apply phase scoped read capabilities:

read_file but only for paths declared in NodeBrief.plan

Maximum 3 read operations per Apply invocation

Read results are ephemeral and not appended to context

2. No Rollback Strategy for Failed Apply Operations
The document mentions pre-apply epoch gates but lacks a recovery mechanism when application fails mid-execution.

Critical questions:

What happens when apply_patch partially succeeds?

Is there a snapshot/checkpoint system?

How do we handle the task_state.json becoming inconsistent?

Recommendation: Implement atomic operations:

typescript
interface AtomicPatch {
  target_path: string;
  pre_image_hash: string;  // SHA256 before mutation
  patch_content: string;
  post_image_hash: string; // Expected after mutation
}

// And a rollback journal:
interface MutationJournal {
  node_id: string;
  operations: AtomicPatch[];
  status: 'pending' | 'committed' | 'rolled_back';
  rollback_script?: string; // Revert commands
}
3. Epoch Validation Creates a "Lazy Re-indexing" Race Condition
"Lazy Re-indexing: Chunks are re-indexed asynchronously upon node execution completion"

This means a NodeBrief generated at epoch 14 could become invalid mid-execution without triggering a re-gather until the next node. Consider this timeline:

text
Node A (Gather) → reads epoch 14 → generates NodeBrief → 
  [External process commits epoch 15] →
Node A (Apply) → validates epoch (mismatch!) → HALT → 
  [But Node A has already consumed resources and latency]
Recommendation: Implementation must include acquire_lock_on_epoch semantics:

typescript
// Orchestrator-level epoch locking
function acquireEpochLock(epoch: number): boolean {
  // Attempt to reserve the current epoch for exclusive execution
  // Reject if epoch number has already advanced
}
4. "LLM-Generated JSON" Failure Modes Underestimated
The fallback parser chain is insufficient for the constraints of local LLMs:

Failure Mode	Your Mitigation	Gap
JSON syntax errors	JSON Repair library	✅
Missing field values	Markdown block extraction	✅
Hallucinated field names	❌ Missing	Schema validation will reject, but no remediation path
Array field has wrong type	❌ Missing	e.g., findings as string instead of array
Semantic incoherence	❌ Missing	Plan mentions file that doesn't exist, but JSON validates
Recommendation: Add a fourth validation stage:

typescript
// Stage 4: Semantic Validation
function validateNodeBriefSemantics(brief: NodeBrief): ValidationResult {
  // 1. Verify all paths in plan exist in relevant[]
  // 2. Verify all relevant paths have expected epoch
  // 3. Check that blockers aren't empty when plan is empty
  // 4. Verify retrieval_snippets paths are in file system
  
  // If semantic validation fails, trigger re-gather with this feedback:
  return {
    valid: false,
    message: "NodeBrief references path 'src/db/migrations/005.sql' but relevant list is empty"
  };
}
🟡 Significant Architectural Concerns
5. RAG Integration Lacks Feedback Loop
The RAG subsystem is described purely as a retrieval mechanism, with no mechanism to learn from retrieval failures.

Scenario: NodeBrief.retrieval_snippets contains irrelevant snippets because vector search retrieved the wrong files.

Current behavior: Continue with bad data.

Missing behavior: Track retrieval quality, adjust embeddings, or request different query formulation.

Recommendation: Add retrieval quality tracking:

json
// In NodeBrief
"retrieval_quality": {
  "avg_relevance_score": 0.87,
  "lowest_snippet": 0.42,
  "snippet_count": 4,
  "manual_correction_requested": false
}
6. Context Chunking: Frontmatter Is Not Enough
The index.md approach is clean, but chunk-00001.md references "Serialised representation of source interfaces" without showing how this is actually represented in the prompt.

Missing details:

Are you sending full markdown chunks to the LLM, or only sections?

How does the LLM know which chunk to retrieve for a given task?

Is the chunk summary in index.md sufficient for retrieval, or do you also use the chunk content?

Recommendation: Specify the chunk inclusion strategy:

typescript
// Option A: All chunks in Gather context (expensive but complete)
// Option B: Selective inclusion based on semantic matching
// Option C: Hierarchical access (index → relevant chunk → excerpt)
Given your token constraints, Option B with dynamic selection is likely optimal:

typescript
function selectChunks(query: string, maxTokens: number): Chunk[] {
  // 1. Rank chunks by TF-IDF similarity to query
  // 2. Select top N until token budget exhausted
  // 3. Ensure selected chunks cover different topics
}
7. No Handling for Multi-File Changes with Dependencies
The NodeBrief.plan is a flat list of { path, change }. This breaks down for:

typescript
// Case 1: Adding a new API endpoint requires:
// - src/api/routes.ts (add route)
// - src/api/handlers.ts (add handler)
// - src/db/models/user.ts (add method)
// - src/api/middleware/auth.ts (update permissions)
Missing: Change dependency tracking. If step 2 fails, do we roll back step 1?

Recommendation: Add a change graph:

typescript
interface ChangeGraph {
  changes: {
    path: string;
    change: string;
    dependencies: string[]; // UUIDs of changes that must precede this one
    rollback_change?: string;
  }[];
}
8. task_state.json Blackboard Does Not Address Accumulation
The blackboard is described as "appended to" over time. This means it will grow unbounded and eventually reproduce the exact problem this architecture aims to solve.

Critical questions:

What is the maximum size of task_state.json?

Are old node summaries truncated?

Is there a summarization/compaction strategy?

Recommendation: Implement blackboard pruning:

json
{
  "active_epoch": 14,
  "global_invariants": ["use JWT_SECRET from env", "API routes are versioned"],
  "recent_nodes": [
    { "id": "node-42", "summary": "Updated auth middleware", "timestamp": "2026-08-08T20:00:00Z" }
  ],
  "older_nodes_summary": "Nodes 1-40: Project initialization, dependency setup, basic CRUD"
}
🟢 Strengths I Want to Highlight
Write-only Apply phase is brave and mostly correct—with the caveat above about scoped reads.

Epoch-based validation is the right level of isolation. This is essentially a lightweight version of MVCC (Multi-Version Concurrency Control) from database systems.

MCP purity restriction is a security best practice. Forcing pure tools only during Gather prevents the "third-party plugin executes rm -rf /" nightmare.

Spill-to-disk threshold for MCP results is clever and underutilized in most agent systems. This prevents a single bad tool call from blowing context.

Performance metrics are realistic and measurable—rare in system design docs.

📊 Metrics & Verification Benchmarks Review
Metric	Target	Verifiability	My Assessment
Input Tokens / Step	3k–6k tokens	✅ Easy	Realistic; 90% reduction is achievable
TTFT	<1.5s	✅ Easy	Depends heavily on hardware; local GPU may struggle
Read-to-Write Ratio	<5:1	✅ Easy	Good, but doesn't account for non-tool LLM inference
Syntax/Type Error Rate	Minimal	❌ Ambiguous	Define "minimal"—5%? 1%? Need threshold
Recommendation: Add a regression test suite to track:

"Apply phase with perfect NodeBrief always succeeds"

"Gather phase with ambiguous query returns blockers correctly"

🧩 Missing Components
9. Observability Layer
The architecture describes execution flow but lacks monitoring. For a system this complex, you need:

typescript
interface Telemetry {
  node_id: string;
  phase: 'gather' | 'apply';
  start_time: string;
  end_time: string;
  token_usage: { input: number; output: number };
  tools_called: { name: string; count: number; total_tokens: number }[];
  fallback_parser_used: 'primary' | 'json_repair' | 'markdown_extract' | 'semantic_fix';
  success: boolean;
  error_message?: string;
}
Why needed: Without this, you cannot empirically validate whether the architecture achieves its claimed improvements.

10. Human-in-the-Loop Breakpoints
Current architecture assumes fully autonomous execution. For sensitive operations (e.g., applying to production code), you need:

typescript
interface HumanGate {
  mode: 'auto' | 'suggest' | 'require_approval';
  approver: string; // User identity
  conditions: {
    // e.g., require approval if NodeBrief.blockers is non-empty
    // or if plan changes > 3 files
    // or if any MCP call returned external data
  };
}
Add this as a configuration layer—different teams will have different risk tolerances.

🔧 Implementation Recommendations
Priority Ordering
Priority	Component	Rationale
P0	Apply phase scoped reads	Without this, Apply will fail in real-world scenarios
P0	Rollback/Atomic operations	Data integrity is non-negotiable
P1	Epoch locking	Prevents race conditions
P1	Semantic validation stage	LLM output will be buggy; catch it early
P2	Telemetry/observability	Need data to prove the design works
P2	Blackboard pruning	Prevents re-introducing context growth
P3	RAG feedback loop	Nice-to-have; can iterate post-launch
P3	Human-in-the-loop gates	Depends on deployment context
Suggested Additional Section: Failure Mode Analysis
Add a table to the "Diagnosis" section:

Failure Mode	Root Cause	Mitigation
NodeBrief plan modifies deleted file	Epoch mismatch between Gather and Apply	Pre-apply epoch gate + re-gather
Apply patch fails due to conflicting changes	Epoch advanced during Apply	Rollback journal + notify operator
RAG returns zero relevant snippets	Poor embedding quality or query formulation	Expand query, try lexical fallback, set blockers
MCP server timeout	External dependency issue	Graceful degradation, continue without MCP
NodeBrief exceeds size limit	Too many findings/plan items	Truncate and set blockers for unresolved items
📝 Final Verdict
Architecture Rating: 7.5/10

This is a well-considered, promising design that addresses a real problem in the local LLM agent space. The core insight—decoupling research from execution—is sound, and the epoch-based validation provides a robust consistency model.

However, the proposal is under-hardened for production use. The "blind mutation" Apply phase, lack of rollback strategy, and missing observability layer mean I would not deploy this to production without significant additional work.

Recommended next steps:

Implement scoped Apply reads (quick win, high impact)

Build the rollback journal (medium effort, prevents data loss)

Add semantic validation to catch LLM hallucinations early

Instrument the system to collect empirical verification metrics





Data Flow Diagram: Two-Phase Agent Loop Architecture
1. System-Level Data Flow (High Level)
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           ORCHESTRATOR ENGINE                                       │
│                                                                                     │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐  │
│  │   Task      │      │   Epoch     │      │   State     │      │   DAG       │  │
│  │   Queue     │─────▶│  Manager    │─────▶│  Blackboard │─────▶│  Controller │  │
│  └─────────────┘      └─────────────┘      └─────────────┘      └─────────────┘  │
│         │                    │                    │                    │           │
│         ▼                    ▼                    ▼                    ▼           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                         NODE EXECUTION CYCLE                                │ │
│  │                                                                             │ │
│  │  ┌────────────────────────┐              ┌────────────────────────┐        │ │
│  │  │   GATHER PHASE         │              │   APPLY PHASE          │        │ │
│  │  │                        │              │                        │        │ │
│  │  │  Research & Discovery  │──NodeBrief──▶│  Deterministic Write   │        │ │
│  │  │  (Ephemeral Context)   │              │  (Bounded Context)     │        │ │
│  │  └────────────────────────┘              └────────────────────────┘        │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────┘

2. Detailed Gather Phase Data Flow
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              GATHER PHASE                                            │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  INPUT: Node Contract                                                      │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │ {                                                                   │  │    │
│  │  │   task: "Add email field to User model and update auth logic",      │  │    │
│  │  │   node_id: "node-0042",                                             │  │    │
│  │  │   epoch: 14,                                                        │  │    │
│  │  │   dependencies: ["src/db/schema/user.ts", "src/auth/jwt.ts"]        │  │    │
│  │  │ }                                                                   │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    1. CONTEXT RETRIEVAL                                    │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │    │
│  │  │  Master      │  │  Lexical     │  │  AST Symbol  │  │  Vector RAG  │  │    │
│  │  │  Index       │  │  Search      │  │  Resolution  │  │  (Optional)  │  │    │
│  │  │  (.aca/)     │  │  (ripgrep)   │  │  (Tree-sitter│  │  (sqlite-vec)│  │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │    │
│  │         │                 │                 │                 │           │    │
│  │         ▼                 ▼                 ▼                 ▼           │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐ │    │
│  │  │  Retrieved Context (Capped at 24,000 tokens)                       │ │    │
│  │  │  ┌───────────────────────────────────────────────────────────────┐ │ │    │
│  │  │  │ - chunk-00004.md (Database schema, ~7,850 tokens)            │ │ │    │
│  │  │  │ - chunk-00001.md (Core architecture, ~7,900 tokens)          │ │ │    │
│  │  │  │ - Snippets from search results (3,000 tokens)                │ │ │    │
│  │  │  │ - MCP query results (if available, ≤12,000 tokens)           │ │ │    │
│  │  │  └───────────────────────────────────────────────────────────────┘ │ │    │
│  │  └─────────────────────────────────────────────────────────────────────┘ │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    2. LLM REASONING (Local Model)                          │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  SYSTEM PROMPT                                                       │  │    │
│  │  │  "You are a code researcher. Given the context, produce a NodeBrief  │  │    │
│  │  │   in valid JSON schema format. Do not include Markdown."             │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  USER PROMPT (Retrieved Context + Task)                             │  │    │
│  │  │  [Context chunks]                                                    │  │    │
│  │  │  [Search snippets]                                                   │  │    │
│  │  │  [Task description]                                                  │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                              │                                            │    │
│  │                              ▼                                            │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  LLM OUTPUT (Raw)                                                   │  │    │
│  │  │  {"findings": [...], "relevant": [...], "plan": [...],             │  │    │
│  │  │   "retrieval_snippets": [...], "blockers": [...]}                  │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    3. NODEBRIEF GENERATION & VALIDATION                     │    │
│  │                                                                             │    │
│  │  ┌──────────────┐                                                          │    │
│  │  │  Stage 1:    │                                                          │    │
│  │  │  Structured  │───▶  Valid? ──▶  ✅ NodeBrief (Schema-Validated)        │    │
│  │  │  JSON Parse  │                                                          │    │
│  │  └──────────────┘                                                          │    │
│  │         │                                                                   │    │
│  │         ▼ (Failure)                                                        │    │
│  │  ┌──────────────┐                                                          │    │
│  │  │  Stage 2:    │                                                          │    │
│  │  │  JSON Repair │───▶  Valid? ──▶  ✅ NodeBrief (Repaired)                │    │
│  │  │  (Syntax)    │                                                          │    │
│  │  └──────────────┘                                                          │    │
│  │         │                                                                   │    │
│  │         ▼ (Failure)                                                        │    │
│  │  ┌──────────────┐                                                          │    │
│  │  │  Stage 3:    │                                                          │    │
│  │  │  Semantic    │───▶  Valid? ──▶  ✅ NodeBrief (Validated)               │    │
│  │  │  Validation  │                                                          │    │
│  │  └──────────────┘                                                          │    │
│  │         │                                                                   │    │
│  │         ▼ (Failure)                                                        │    │
│  │  ┌──────────────┐                                                          │    │
│  │  │  ❌ HALT     │                                                          │    │
│  │  │  Execution   │───▶  Log Error → Notify Operator → Re-Gather            │    │
│  │  │  Failed      │                                                          │    │
│  │  └──────────────┘                                                          │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    4. NODEBRIEF PERSISTENCE                                 │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  .aca/nodes/node-0042-brief.json                                     │  │    │
│  │  │  {                                                                   │  │    │
│  │  │    "findings": ["User model lacks email field", ...],                │  │    │
│  │  │    "relevant": [{"path": "src/db/schema/user.ts", "epoch": 14}],    │  │    │
│  │  │    "plan": [{"path": "...", "change": "..."}],                       │  │    │
│  │  │    "retrieval_snippets": [...],                                      │  │    │
│  │  │    "blockers": []                                                    │  │    │
│  │  │  }                                                                   │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘


3. Detailed Apply Phase Data Flow

┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              APPLY PHASE                                            │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  INPUT: NodeBrief (from Gather Phase)                                      │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  NodeBrief {                                                         │  │    │
│  │  │    "findings": [...],                                                │  │    │
│  │  │    "relevant": [{"path": "src/db/schema/user.ts", "epoch": 14}],    │  │    │
│  │  │    "plan": [{"path": "src/db/schema/user.ts", "change": "..."}],    │  │    │
│  │  │    "retrieval_snippets": [...],                                      │  │    │
│  │  │    "blockers": []                                                    │  │    │
│  │  │  }                                                                   │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    1. EPOCH VALIDATION GATE                               │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Check: Does NodeBrief.epoch == MasterIndex.active_epoch?            │  │    │
│  │  │                                                                       │  │    │
│  │  │  ┌─────────────────────────────────────────────────────────────────┐ │  │    │
│  │  │  │  ✅ Match → Proceed to Apply                                   │ │  │    │
│  │  │  │  ❌ Mismatch → HALT → Re-Gather with new epoch                │ │  │    │
│  │  │  └─────────────────────────────────────────────────────────────────┘ │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    2. CONTEXT CONSTRUCTION                                  │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Fresh Context (3,000 - 6,000 tokens total):                         │  │    │
│  │  │                                                                       │  │    │
│  │  │  ┌─────────────────────────────────────────────────────────────────┐ │  │    │
│  │  │  │ 1. Task Contract (500 tokens)                                   │ │  │    │
│  │  │  │ 2. NodeBrief (1,000 tokens)                                     │ │  │    │
│  │  │  │ 3. Target Files (2,000 - 4,000 tokens)                         │ │  │    │
│  │  │  │    - src/db/schema/user.ts (current content)                    │ │  │    │
│  │  │  │    - src/auth/jwt.ts (current content)                          │ │  │    │
│  │  │  │ 4. ✅ NO historical context                                     │ │  │    │
│  │  │  │ 5. ✅ NO tool logs                                               │ │  │    │
│  │  │  └─────────────────────────────────────────────────────────────────┘ │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    3. LLM REASONING (Write-Only Focus)                      │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  SYSTEM PROMPT                                                       │  │    │
│  │  │  "You are a code writer. Generate patches for the target files.      │  │    │
│  │  │   Only output valid unified diff patches. No explanations."          │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  USER PROMPT                                                         │  │    │
│  │  │  NodeBrief: [structured data]                                        │  │    │
│  │  │  Target File 1: [content of user.ts]                                 │  │    │
│  │  │  Target File 2: [content of jwt.ts]                                  │  │    │
│  │  │  Task: Generate patches per the NodeBrief.plan                       │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                              │                                            │    │
│  │                              ▼                                            │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  LLM OUTPUT (Unified Diff Format)                                    │  │    │
│  │  │  ```diff                                                             │  │    │
│  │  │  --- src/db/schema/user.ts                                           │  │    │
│  │  │  +++ src/db/schema/user.ts                                           │  │    │
│  │  │  @@ -45,6 +45,7 @@                                                   │  │    │
│  │  │   interface User {                                                   │  │    │
│  │  │     id: string;                                                      │  │    │
│  │  │     name: string;                                                    │  │    │
│  │  │  +  email: string;                                                   │  │    │
│  │  │   }                                                                  │  │    │
│  │  │  ```                                                                │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    4. PATCH EXECUTION                                       │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  For each patch in NodeBrief.plan:                                   │  │    │
│  │  │                                                                       │  │    │
│  │  │  ┌─────────────────────────────────────────────────────────────────┐ │  │    │
│  │  │  │  Patch Target: src/db/schema/user.ts                            │ │  │    │
│  │  │  │                                                                   │ │  │    │
│  │  │  │  1. Read current content (allowed: target in NodeBrief.relevant)│ │  │    │
│  │  │  │  2. Compute pre-image SHA256                                    │ │  │    │
│  │  │  │  3. Apply patch                                                  │ │  │    │
│  │  │  │  4. Compute post-image SHA256                                   │ │  │    │
│  │  │  │  5. Write to .aca/journal/node-0042.log                        │ │  │    │
│  │  │  └─────────────────────────────────────────────────────────────────┘ │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Rollback Journal                                                    │  │    │
│  │  │  .aca/journal/node-0042.json                                         │  │    │
│  │  │  {                                                                   │  │    │
│  │  │    "node_id": "node-0042",                                           │  │    │
│  │  │    "operations": [                                                   │  │    │
│  │  │      {                                                               │  │    │
│  │  │        "target": "src/db/schema/user.ts",                            │  │    │
│  │  │        "pre_hash": "sha256:abc123...",                               │  │    │
│  │  │        "post_hash": "sha256:def456...",                              │  │    │
│  │  │        "applied": true                                               │  │    │
│  │  │      }                                                               │  │    │
│  │  │    ],                                                                │  │    │
│  │  │    "status": "committed"                                             │  │    │
│  │  │  }                                                                   │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                    5. POST-APPLY ACTIONS                                    │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  1. ✅ Write to disk (atomic)                                        │  │    │
│  │  │  2. 🔄 Bump epoch to 15                                              │  │    │
│  │  │  3. 🔄 Invalidate affected chunks (synchronous)                     │  │    │
│  │  │  4. 🔄 Re-index affected chunks (eager)                             │  │    │
│  │  │  5. 📊 Update task_state.json (node completion record)              │  │    │
│  │  │  6. ✅ Return execution result to orchestrator                      │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘

4. State Management & Persistence Data Flow

┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        STATE MANAGEMENT LAYER                                       │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │                      .aca/ DIRECTORY STRUCTURE                             │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  context/                                                            │  │    │
│  │  │  ├── index.md              # Master index (< 2,000 tokens)          │  │    │
│  │  │  ├── meta.json             # SHA256 hashes, active_epoch            │  │    │
│  │  │  ├── chunk-00001.md        # ~7,500 tokens                         │  │    │
│  │  │  ├── chunk-00002.md        # ~7,500 tokens                         │  │    │
│  │  │  └── chunk-00004.md        # ~7,500 tokens                         │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  nodes/                                                              │  │    │
│  │  │  ├── node-0042-brief.json      # NodeBrief for node 42             │  │    │
│  │  │  └── node-0042-result.json     # Execution result                  │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  journal/                                                           │  │    │
│  │  │  └── node-0042.log               # Rollback journal                │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  artifacts/                                                         │  │    │
│  │  │  └── mcp-export-2026-08-08-20-00-00.json  # MCP spill data         │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  task_state.json             # Persistent blackboard               │  │    │
│  │  │  {                                                                   │  │    │
│  │  │    "active_epoch": 15,                                               │  │    │
│  │  │    "completed_nodes": ["node-0042"],                                 │  │    │
│  │  │    "global_invariants": ["JWT_SECRET required", ...],               │  │    │
│  │  │    "recent_nodes": [{"id": "node-0042", "summary": "..."}]          │  │    │
│  │  │  }                                                                   │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘


5. Epoch & Index Invalidation Flow

┌─────────────────────────────────────────────────────────────────────────────────────┐
│                    EPOCH STATE TRANSITION FLOW                                      │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  STATE: Epoch 14 (Initial)                                                 │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Master Index:                                                       │  │    │
│  │  │  ├── chunk-00001.md (SHA: abc123, Epoch: 14)                       │  │    │
│  │  │  ├── chunk-00004.md (SHA: def456, Epoch: 14)                       │  │    │
│  │  │  └── chunk-00008.md (SHA: ghi789, Epoch: 14)                       │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  EVENT: Node 42 Apply Phase Executes                                       │    │
│  │  - Modifies: src/db/schema/user.ts (part of chunk-00004.md)               │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  ACTION: Eager Re-Indexing                                                │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  1. Identify affected chunks:                                       │  │    │
│  │  │     - chunk-00004.md (contains src/db/schema/user.ts)             │  │    │
│  │  │                                                                     │  │    │
│  │  │  2. Invalidate chunk-00004.md from cache                           │  │    │
│  │  │                                                                     │  │    │
│  │  │  3. Re-generate chunk-00004.md from updated files                  │  │    │
│  │  │                                                                     │  │    │
│  │  │  4. Update SHA: def456 → fgh789                                   │  │    │
│  │  │                                                                     │  │    │
│  │  │  5. Bump epoch: 14 → 15                                           │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  STATE: Epoch 15 (Updated)                                               │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Master Index:                                                       │  │    │
│  │  │  ├── chunk-00001.md (SHA: abc123, Epoch: 15)                       │  │    │
│  │  │  ├── chunk-00004.md (SHA: fgh789, Epoch: 15)  ← CHANGED           │  │    │
│  │  │  └── chunk-00008.md (SHA: ghi789, Epoch: 15)                       │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                           │
│                                        ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  EVENT: Node 43 Gather Phase Requests Context                            │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Pre-Apply Gate:                                                     │  │    │
│  │  │  - Node 43 NodeBrief references epoch 14                            │  │    │
│  │  │  - Master Index active epoch: 15                                    │  │    │
│  │  │  - ❌ MISMATCH → HALT → Re-Gather                                  │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘


6. MCP Integration Data Flow (Gather Phase)

┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        MCP CLIENT INTEGRATION                                       │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  GATHER PHASE MCP WORKFLOW                                                 │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Input: MCP Tool Request                                            │  │    │
│  │  │  Query: "Search GitHub for JWT authentication patterns"            │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                              │                                            │    │
│  │                              ▼                                            │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  MCP Client Gateway                                                │  │    │
│  │  │                                                                     │  │    │
│  │  │  1. Validate tool is PURE (read-only)                             │  │    │
│  │  │  2. Check timeout: 10,000ms                                        │  │    │
│  │  │  3. Prefix namespace: mcp__github__search                         │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                              │                                            │    │
│  │              ┌───────────────┼───────────────────────────────┐           │    │
│  │              ▼               ▼                               ▼           │    │
│  │  ┌──────────────────┐ ┌──────────────────┐ ┌─────────────────────────┐ │    │
│  │  │  MCP Server      │ │  MCP Server      │ │  MCP Server             │ │    │
│  │  │  (GitHub)        │ │  (Slack)         │ │  (Internal Wiki)        │ │    │
│  │  └──────────────────┘ └──────────────────┘ └─────────────────────────┘ │    │
│  │         │                   │                       │                   │    │
│  │         ▼                   ▼                       ▼                   │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Result Aggregation                                                │  │    │
│  │  │                                                                     │  │    │
│  │  │  ┌──────────────────────────────────────────────────────────────┐ │  │    │
│  │  │  │  If result > 12,000 tokens:                                  │ │  │    │
│  │  │  │  1. Write to .aca/artifacts/mcp-export-{timestamp}.json    │ │  │    │
│  │  │  │  2. Return artifact pointer: read_artifact('...')          │ │  │    │
│  │  │  │  Else:                                                        │ │  │    │
│  │  │  │  3. Embed in NodeBrief.retrieval_snippets                   │ │  │    │
│  │  │  └──────────────────────────────────────────────────────────────┘ │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  │                              │                                            │    │
│  │                              ▼                                            │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  Output: Enriched NodeBrief                                         │  │    │
│  │  │  {                                                                   │  │    │
│  │  │    "findings": ["GitHub pattern: use jwt.verify()"],                │  │    │
│  │  │    "retrieval_snippets": [                                          │  │    │
│  │  │      {                                                              │  │    │
│  │  │        "snippet": "function verifyToken(token) { ... }",           │  │    │
│  │  │        "provenance": "mcp://github.com/pattern-123"               │  │    │
│  │  │      }                                                              │  │    │
│  │  │    ],                                                               │  │    │
│  │  │    "blockers": []                                                   │  │    │
│  │  │  }                                                                   │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘



7. Complete End-to-End Flow Sequence


┌─────────────────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE NODE EXECUTION SEQUENCE                                 │
│                                                                                     │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐      │
│  │  1. Task    │     │  2. Gather  │     │  3. NodeBrief│    │  4. Apply   │      │
│  │   Creation  │────▶│   Phase     │────▶│  Validation  │───▶│   Phase     │      │
│  │             │     │             │     │             │     │             │      │
│  └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘      │
│         │                   │                   │                   │              │
│         ▼                   ▼                   ▼                   ▼              │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │  Input: Task       │  Input: Task +     │  Input: Raw LLM    │  Input:     │  │
│  │  Description       │  Context           │  Output            │  NodeBrief  │  │
│  │                     │                    │                    │             │  │
│  │                     │  Operations:       │  Operations:       │  Operations:│  │
│  │                     │  - Query Index     │  1. JSON Parse     │  1. Epoch   │  │
│  │                     │  - Search Code     │  2. JSON Repair    │     Gate    │  │
│  │                     │  - MCP Calls       │  3. Semantic Val.  │  2. Context │  │
│  │                     │  - LLM Reasoning   │  4. Persist        │  3. LLM     │  │
│  │                     │                    │                     │  4. Apply   │  │
│  │                     │  Output:           │  Output:           │  5. Re-Index│  │
│  │                     │  Raw LLM Output    │  NodeBrief JSON    │             │  │
│  │                     │                    │                     │  Output:    │  │
│  │                     │                    │                     │  Modified   │  │
│  │                     │                    │                     │  Files      │  │
│  └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                     │
│          │                       │                       │                       │  │
│          ▼                       ▼                       ▼                       ▼  │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐      │
│  │  5. State   │     │  6. Epoch   │     │  7. Index   │     │  8. Next    │      │
│  │   Update    │────▶│   Bump      │────▶│   Invalidate│────▶│   Node      │      │
│  │             │     │             │     │             │     │             │      │
│  └─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘      │
│                                                                                     │
│  Flow:                                                                              │
│  1. Orchestrator creates task from DAG/queue                                      │
│  2. Gather phase discovers and plans                                               │
│  3. NodeBrief validation ensures quality                                           │
│  4. Apply phase executes changes                                                   │
│  5. State blackboard updated                                                      │
│  6. Epoch increments (if files changed)                                          │
│  7. Affected chunks invalidated and re-indexed                                   │
│  8. Next node begins or execution complete                                        │
└─────────────────────────────────────────────────────────────────────────────────────┘


8. Data Flow Legend

┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              LEGEND                                                 │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  SYMBOLS                                                                    │    │
│  │                                                                             │    │
│  │  ┌─────┐  Process/Component                                               │    │
│  │  ────▶  Data Flow Direction                                                │    │
│  │  ──▶    Control Flow                                                       │    │
│  │  ✓      Success Path                                                       │    │
│  │  ✗      Failure Path                                                       │    │
│  │  ❌      Halt/Error                                                        │    │
│  │  ✅      Validation Pass                                                   │    │
│  │  🔄      State Transition                                                  │    │
│  │  📊      Persistence/Logging                                               │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  DATA TYPES                                                                │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  NodeContract   │  Task input contract from orchestrator           │  │    │
│  │  │  NodeBrief      │  Structured handoff payload                       │  │    │
│  │  │  Diff Patch     │  Unified diff format                              │  │    │
│  │  │  Journal Entry  │  Rollback/audit record                           │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                     │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  │  STORAGE                                                                    │    │
│  │                                                                             │    │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │    │
│  │  │  .aca/context/     │  Markdown chunks and master index             │  │    │
│  │  │  .aca/nodes/       │  NodeBrief and execution results              │  │    │
│  │  │  .aca/journal/     │  Rollback and audit logs                      │  │    │
│  │  │  .aca/artifacts/   │  Large MCP exports                           │  │    │
│  │  │  .aca/task_state   │  Persistent blackboard                        │  │    │
│  │  │  .aca/meta.json    │  Epoch, SHA256, versioning                   │  │    │
│  │  └─────────────────────────────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────────┘