# Forge — Local Agent IDE

Forge v2 is a native Windows coding-assistant IDE for local/open-weight models. It keeps the original Forge Electron/Monaco IDE and the Code-OSS workbench as two supported shells over one local agent service. A bounded planner creates an ordered task queue; every task uses a fresh read-only **Gather** phase and a fresh constrained **Apply** phase before any verified change can be promoted.

![Forge architecture](./senior_ai_dataflow.svg)

## What is implemented

- Electron + React + Monaco Windows IDE with native folder selection, multi-tab editing, frameless window controls, save conflict detection, local-model settings, and a live agent event timeline.
- Local adapters for **Ollama**, **LM Studio**, and **llama.cpp**. The API accepts loopback endpoints only.
- Automatic runtime discovery on ports `11434`, `1234`, and `8080`; Forge selects a model that is actually available instead of assuming a model name.
- Strict planner output, bounded task queues, explicit acceptance criteria, and one bounded replan when aggregate verification fails.
- Repository snapshot and per-file SHA-256 preconditions.
- Bounded lexical/structural-context retrieval with focused evidence regions.
- Strict `ExecutionBrief` and mutation-set validation with one correction attempt.
- Read-only context requests and explicit scope-amendment requests; the model cannot silently widen its write set.
- Just-in-time target hydration; Apply has no search, MCP, shell, or general read capability.
- Copy-on-write staging, evidence/target CAS checks, a persistent promotion journal with recovery/rollback, and an audit log at `.forge/audit.jsonl`.
- Classified repair: fast Apply-only repair for syntax/type/lint failures and deep Gather/Apply repair for other failures.
- Persistent run manifests in `.forge/runs/`, safe suspend/resume/discard controls, and final aggregate verification across completed tasks.
- High-risk plans stop for human review. `discussion` directories are excluded from browsing, retrieval, staging, and mutation.

## Code-OSS Windows application

Forge now runs as a built-in Code-OSS workbench extension. This preserves the
existing Gather/Apply agent loop as an authenticated loopback worker while
adding the full editor workbench, integrated terminal, debugger, SCM, language
services, keybindings, and the native Extensions view.

The Forge Agent chat opens automatically in the Secondary Side Bar. It contains
runtime and model selection, a task composer, and the live Gather/Apply event
timeline. Use **Forge: Open Agent Chat** from the Command Palette if the view is
closed. Model discovery remains available in Restricted Mode; autonomous
repository operations require the open folder to be trusted.

Create or refresh the workspace-contained Windows runtime, then launch it:

```powershell
npm run code-oss:runtime
npm run code-oss:run
```

The runtime is a SHA-256-verified official VSCodium release (a Code-OSS
distribution) patched with Forge branding and the built-in Forge extension. It
is not installed system-wide. User data and extensions live under `.forge/`, so
existing Visual Studio Code, VSCodium, and Forge profiles are not changed.

Open VSX is configured as the extension gallery. You can also use **Extensions:
Install from VSIX...** from the Command Palette or Extensions view. The
standalone Forge extension is produced at `release/forge-agent-0.5.0.vsix`.

To build directly from Microsoft's official Code-OSS source instead, install
the Windows C++ build workload including the latest x64/x86 Spectre-mitigated
libraries, then run:

```powershell
npm run code-oss:bootstrap
npm run code-oss:run
```

The bootstrap uses the shallow checkout at `vendor/code-oss`, applies
`code-oss/product-overrides.json`, and copies Forge into Code-OSS's built-in
`extensions/` directory. `npm run code-oss:sync` reapplies Forge after an
upstream update.

To create a distributable portable ZIP:

```powershell
npm run code-oss:package
npm run code-oss:installer
```

## Original Forge IDE

The original Electron/React/Monaco interface remains supported as the focused
Forge experience. It includes the Forge v2 chat, local runtime/model selection,
task plan and event timeline, suspension decisions, repository tree, editor,
runtime settings, workspace content search, Git status, trusted project checks,
file navigation history, split/maximized editing, and a command palette. Chat
mode handles ordinary Markdown conversations; Agent v2 is selected explicitly
for autonomous coding transactions. Code-OSS remains the full-workbench option
for debugging, terminals, language services, keybindings, and VSIX/Open VSX
extensions.

Run or package the original shell independently:

```powershell
npm run forge:desktop:dev
npm run forge:dist:win
```

Its artifacts use `Forge-Original-IDE-*` names so they cannot be confused with
the `Forge-CodeOSS-*` installer and portable ZIP.

On first launch Forge opens your Documents folder. Use the folder button beside the workspace name to choose a code repository; the last workspace is remembered.

Forge scans all supported local runtimes at startup. Ollama's service normally starts with the Ollama app. For LM Studio or a llama.cpp-compatible app, make sure its local API server is running. Open Forge Settings to see live status dots, discovered model counts, and the exact model picker.

## Run from source

Requirements: Node.js 20+ and one local inference server.

```bash
npm install
npm run code-oss:runtime
npm run desktop
```

To rebuild the Forge extension, integrate it into the local Code-OSS runtime,
and launch the workbench:

```bash
npm run desktop:dev
```

The original Forge IDE runs with `npm run forge:desktop:dev`. The Code-OSS IDE
runs with `npm run codeoss:desktop:dev` (or the compatible `desktop:dev` alias).
The browser-hosted original interface uses `npm run dev` at
[http://127.0.0.1:5173](http://127.0.0.1:5173).

Default provider endpoints:

| Provider | Endpoint | API |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` | `/api/chat`, `/api/tags` |
| LM Studio | `http://127.0.0.1:1234` | OpenAI-compatible `/v1` |
| llama.cpp | `http://127.0.0.1:8080` | OpenAI-compatible `/v1` |

Use the gear button in Forge to choose among the automatically detected providers and models or retry a custom loopback endpoint.

To make Forge operate on another repository, start the API with an explicit workspace root:

```powershell
$env:WORKSPACE_ROOT = "C:\path\to\project"
npm run dev
```

## Verification

```bash
npm run typecheck
npm test
npm run test:code-oss
npm run build
npm run extension:package
npm run forge:dist:win
npm run code-oss:package
npm run code-oss:installer
```

In a staged candidate workspace, Forge runs recognized trusted scripts in this order when present: `typecheck`, `lint`, `test`, and `build`. Commands suggested by a model are recorded in the brief but are never executed automatically.

## Safety model

```text
task → bounded plan → task queue → fresh snapshot/Gather → validate brief
     → evidence CAS/hydration → fresh Apply → validate write set → isolated stage
     → classified verification/repair → target CAS → journaled promotion → audit
     → final aggregate verification → complete or bounded replan/suspend
```

The source workspace remains untouched when a model response is invalid, a preimage is stale, a mutation escapes its declared write set, or staged verification fails. External MCP mutation is intentionally not part of this P0 implementation.
