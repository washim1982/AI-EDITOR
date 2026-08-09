# System Requirements: Robust Two-Phase Agent Loop for Local LLM Code Assistants

## Executive Summary
This document outlines the synthesized requirements for building an autonomous software engineering agent powered by open-weight local LLMs (e.g., Qwen 3.6 35B, Gemma 4 31B). It is generated from a comprehensive review of the project's architectural blueprints, team discussions, and critical peer reviews. The core objective is to eliminate catastrophic token accumulation and context rot by decoupling research (Gather) from execution (Apply).

---

## 1. Agreed Architectural Principles

All reviewed documents (`01-loop-redesign.md`, `copilot_architecture.md`, `Final_gemini_Review.md`, and discussion notes) establish consensus on the following foundational elements:

### 1.1 Decoupled Two-Phase Execution
- **Gather Phase (Research & Discovery):** Ephemeral, read-only phase bounded by a strict step cap and read token ceiling (e.g., 24,000 tokens). Can use workspace read tools, vector/lexical index search, and pure MCP tools.
- **Apply Phase (Deterministic Code Mutation):** Write-only phase (with caveats, see Section 2) that executes code changes deterministically. Opens with a fresh, minimal context (3,000–6,000 tokens).

### 1.2 The NodeBrief Handoff
- The phases communicate exclusively via a schema-validated `NodeBrief` JSON object containing `findings`, `relevant` files, a modification `plan`, `retrieval_snippets`, and `blockers`.
- **Multi-Stage Fallback Parser:** To ensure small model robustness, NodeBrief generation uses strict grammar decoding -> automated JSON syntax repair -> Markdown block extraction.

### 1.3 Context Management & Master Index
- **Deterministic Chunking:** The codebase is split into ~7.5k-8k token Markdown chunks with YAML frontmatter.
- **Master Index:** A lightweight `index.md` (<2,000 tokens) provides a map of all chunks.
- **Task Blackboard:** Multi-node execution context is preserved across nodes in a `.aca/task_state.json` file.

### 1.4 State Validation Gates
- **Monotonic Epoch Counter:** Tracks workspace mutations.
- **Pre-Apply Epoch Gate:** The orchestrator verifies that the `epoch` values declared in the `NodeBrief` match the Master Index. A mismatch halts execution and triggers a re-gather.

### 1.5 Safe MCP Integration & Hybrid RAG
- **MCP Constraints:** Third-party Model Context Protocol (MCP) tools are strictly confined to the Gather phase, forced to read-only ("pure"), namespaced, and subject to a 12,000-token spill-to-disk threshold.
- **Hybrid RAG:** Exclusively within Gather, retrieval combines dense vector search ($k$-NN) and sparse lexical matching (grep/BM25). Snippets are wrapped in `<<<UNTRUSTED_DATA>>>`.

---

## 2. Contentions & Disagreed Points (Required Hardening)

The architectural review (`deepseek-review.md`) highlighted several critical disagreements with the original blueprint, identifying areas where the initial design is under-hardened or overly rigid.

> [!WARNING]
> **Critical Issue: Apply Phase Blindness**
> The original design dictates that the Apply phase is **strictly write-only** with no read tools.
> **Disagreement:** The review argues this creates "blind mutations." If target line numbers or imports shift between Gather and Apply, the write will fail destructively.
> **Resolution / Required Change:** Grant the Apply phase scoped, ephemeral read capabilities (e.g., `read_file` restricted only to paths explicitly declared in `NodeBrief.plan`).

> [!CAUTION]
> **Critical Issue: Missing Rollback Strategy**
> The original design implements pre-apply epoch gating but ignores mid-execution application failure.
> **Disagreement:** There is no mechanism to recover if `apply_patch` partially succeeds, leaving the workspace and `task_state.json` inconsistent.
> **Resolution / Required Change:** Implement a `MutationJournal` allowing atomic operations and automated rollback for failed apply sequences.

> [!IMPORTANT]
> **Lazy Re-indexing Race Conditions**
> **Disagreement:** Lazy re-indexing allows the epoch to advance while a node is still executing, leading to wasted compute and latency before the Pre-Apply Gate catches the mismatch.
> **Resolution / Required Change:** Implement an orchestrator-level `acquireEpochLock()` to reserve the epoch for exclusive execution.

### Additional Disagreed / Missing Elements
1. **LLM JSON Failure Modes:** The 3-stage fallback doesn't catch semantic hallucinations (e.g., hallucinating a valid file path that doesn't exist). *Agreed Fix:* Add a 4th stage for "Semantic Validation" prior to Apply.
2. **Task Blackboard Accumulation:** Appending to `task_state.json` will eventually cause unbounded growth, recreating the context rot problem. *Agreed Fix:* Implement summarization and pruning for older nodes in the blackboard.
3. **Multi-File Change Dependencies:** A flat list of changes in `NodeBrief.plan` cannot handle sequenced dependencies (e.g., must create route file before modifying registry). *Agreed Fix:* Introduce a dependency graph within the change plan.
4. **RAG Feedback Loop:** The RAG subsystem blindly accepts retrieved snippets. *Agreed Fix:* Introduce retrieval quality tracking inside the NodeBrief to allow the LLM to request a query re-formulation.
5. **Observability & Telemetry:** The initial design lacked empirical monitoring. *Agreed Fix:* Add an explicit telemetry layer tracking `TTFT`, `token_usage`, and `fallback_parser_used`.

---

## 3. Final Reconciled Implementation Roadmap

To move forward, the implementation should integrate the core Two-Phase architecture while prioritizing the critical patches identified in the review.

### Priority 0: Core Loop & Data Integrity (Immediate)
- Implement Gather/Apply split with schema-validated `NodeBrief`.
- Implement **scoped reads for the Apply phase** (resolving "Apply phase blindness").
- Implement the **Rollback Journal** (atomic patch applications).

### Priority 1: State & Synchronization
- Implement Deterministic Chunking and Master Index.
- Implement Epoch Locking to prevent lazy-indexing race conditions.
- Implement the 4-stage Fallback Parser (including Semantic Validation).

### Priority 2: Advanced Discovery & Safety
- Integrate Hybrid RAG and pure MCP tools (confined to Gather).
- Implement Task Blackboard with automatic pruning/summarization.
- Add comprehensive telemetry and observability interfaces.
