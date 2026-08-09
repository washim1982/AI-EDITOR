import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type BeforeMount } from "@monaco-editor/react";
import {
  Blocks,
  Bot,
  Bug,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Files,
  GitBranch,
  LayoutPanelLeft,
  Maximize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Sparkles,
  Terminal,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import type { editor } from "monaco-editor";
import { AgentPanel } from "./AgentPanel";
import { fetchFile, fetchModels, fetchRuntimes, fetchTree, saveFile, streamAgentRun } from "./api";
import { Explorer } from "./Explorer";
import type {
  AgentEvent,
  ProviderConfig,
  ProviderKind,
  RuntimeStatus,
  TreeNode,
  WorkspaceFile,
} from "../shared/types";

const DEFAULTS: Record<ProviderKind, ProviderConfig> = {
  ollama: {
    kind: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "",
    temperature: 0.1,
  },
  lmstudio: {
    kind: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "",
    temperature: 0.1,
  },
  llamacpp: {
    kind: "llamacpp",
    endpoint: "http://127.0.0.1:8080",
    model: "",
    temperature: 0.1,
  },
};

function loadStoredConfig(): ProviderConfig {
  try {
    const stored = localStorage.getItem("forge.provider");
    return stored ? { ...DEFAULTS.ollama, ...JSON.parse(stored) } : DEFAULTS.ollama;
  } catch {
    return DEFAULTS.ollama;
  }
}

function flattenFiles(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => node.type === "file" ? [node] : flattenFiles(node.children || []));
}

function basename(filePath: string): string {
  return filePath.split("/").at(-1) || filePath;
}

function chooseDetectedProvider(current: ProviderConfig, runtimes: RuntimeStatus[]): ProviderConfig {
  const currentRuntime = runtimes.find((runtime) => runtime.kind === current.kind && runtime.reachable && runtime.models.length);
  const selectedRuntime = currentRuntime || runtimes.find((runtime) => runtime.reachable && runtime.models.length);
  if (!selectedRuntime) return { ...current, model: "" };
  return {
    ...current,
    kind: selectedRuntime.kind,
    endpoint: selectedRuntime.endpoint,
    model: selectedRuntime.models.includes(current.model) ? current.model : selectedRuntime.models[0],
  };
}

function EditorTabs({
  tabs,
  activePath,
  drafts,
  onActivate,
  onClose,
}: {
  tabs: WorkspaceFile[];
  activePath?: string;
  drafts: Record<string, string>;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    <div className="editor-tabs">
      {tabs.map((tab) => {
        const dirty = drafts[tab.path] !== undefined && drafts[tab.path] !== tab.content;
        return (
          <button
            key={tab.path}
            className={`editor-tab ${activePath === tab.path ? "active" : ""}`}
            onClick={() => onActivate(tab.path)}
            title={tab.path}
          >
            <Code2 />
            <span>{basename(tab.path)}</span>
            {dirty ? <i className="dirty-dot" /> : <X onClick={(event) => { event.stopPropagation(); onClose(tab.path); }} />}
          </button>
        );
      })}
      <div className="tabs-spacer" />
      <button className="tabs-action" title="Split editor"><LayoutPanelLeft /></button>
      <button className="tabs-action" title="Editor actions"><span>•••</span></button>
    </div>
  );
}

function SettingsModal({
  config,
  runtimes,
  onClose,
  onSave,
}: {
  config: ProviderConfig;
  runtimes: RuntimeStatus[];
  onClose: () => void;
  onSave: (config: ProviderConfig) => void;
}) {
  const [draft, setDraft] = useState(config);
  const initialRuntime = runtimes.find((runtime) => runtime.kind === config.kind);
  const [models, setModels] = useState<string[]>(initialRuntime?.models || []);
  const [connection, setConnection] = useState<"idle" | "loading" | "success" | "error">(
    initialRuntime?.reachable ? "success" : initialRuntime ? "error" : "idle",
  );
  const [message, setMessage] = useState(
    initialRuntime?.reachable
      ? `${initialRuntime.models.length} local model${initialRuntime.models.length === 1 ? "" : "s"} detected automatically.`
      : initialRuntime?.error || "Scanning for local model servers…",
  );

  const setKind = (kind: ProviderKind) => {
    const runtime = runtimes.find((item) => item.kind === kind);
    const next = {
      ...DEFAULTS[kind],
      endpoint: runtime?.endpoint || DEFAULTS[kind].endpoint,
      model: runtime?.models[0] || "",
      temperature: draft.temperature,
    };
    setDraft(next);
    setModels(runtime?.models || []);
    setConnection(runtime?.reachable ? "success" : runtime ? "error" : "idle");
    setMessage(runtime?.reachable
      ? `${runtime.models.length} local model${runtime.models.length === 1 ? "" : "s"} detected automatically.`
      : runtime?.error || "Click retry to scan this endpoint.");
  };

  const discover = async () => {
    setConnection("loading");
    setMessage("Connecting to the local inference server…");
    try {
      const result = await fetchModels(draft);
      setModels(result);
      setConnection("success");
      setMessage(result.length ? `${result.length} local model${result.length === 1 ? "" : "s"} available.` : "Connected, but no models were reported.");
      if (result.length && !result.includes(draft.model)) setDraft((current) => ({ ...current, model: result[0] }));
    } catch (error) {
      setConnection("error");
      setMessage(error instanceof Error ? error.message : "Could not connect.");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="settings-icon"><Settings /></span><div><h2>Local model runtime</h2><p>Inference stays on your machine.</p></div></div>
          <button onClick={onClose}><X /></button>
        </header>
        <div className="runtime-tabs">
          {(Object.keys(DEFAULTS) as ProviderKind[]).map((kind) => {
            const runtime = runtimes.find((item) => item.kind === kind);
            return (
              <button key={kind} className={draft.kind === kind ? "active" : ""} onClick={() => setKind(kind)}>
                <i className={runtime?.reachable && runtime.models.length ? "online" : "offline"} />
                {kind === "ollama" ? "Ollama" : kind === "lmstudio" ? "LM Studio" : "llama.cpp"}
                {runtime?.models.length ? <small>{runtime.models.length}</small> : null}
              </button>
            );
          })}
        </div>
        <div className="settings-form">
          <label>
            <span>Server endpoint</span>
            <input value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} />
            <small>Only localhost and 127.0.0.1 endpoints are accepted by the API.</small>
          </label>
          <label>
            <span>Model</span>
            {models.length ? (
              <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
                {models.map((model) => <option key={model}>{model}</option>)}
              </select>
            ) : (
              <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="No model detected" />
            )}
          </label>
          <label>
            <span>Temperature <strong>{draft.temperature.toFixed(1)}</strong></span>
            <input type="range" min="0" max="1" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} />
          </label>
          <div className={`connection-result ${connection}`}>
            <span>{connection === "success" ? <Check /> : connection === "error" ? <X /> : <Zap />}</span>
            <p>{message}</p>
            <button onClick={discover} disabled={connection === "loading"}>{connection === "loading" ? "Scanning…" : "Retry discovery"}</button>
          </div>
        </div>
        <footer>
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(draft)}>Save runtime</button>
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  const [tabs, setTabs] = useState<WorkspaceFile[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [config, setConfig] = useState<ProviderConfig>(loadStoredConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [task, setTask] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [agentError, setAgentError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [discoveringRuntimes, setDiscoveringRuntimes] = useState(true);
  const controllerRef = useRef<AbortController>();
  const desktop = Boolean(window.forgeDesktop);

  const activeFile = tabs.find((tab) => tab.path === activePath);
  const activeDraft = activePath ? drafts[activePath] ?? activeFile?.content ?? "" : "";
  const dirty = Boolean(activeFile && activeDraft !== activeFile.content);
  const rootName = workspacePath.split(/[\\/]/).filter(Boolean).at(-1)?.toUpperCase() || "WORKSPACE";
  const activeRuntime = runtimes.find((runtime) => runtime.kind === config.kind);

  const refreshRuntimes = useCallback(async () => {
    setDiscoveringRuntimes(true);
    try {
      const discovered = await fetchRuntimes();
      setRuntimes(discovered);
      setConfig((current) => {
        const next = chooseDetectedProvider(current, discovered);
        localStorage.setItem("forge.provider", JSON.stringify(next));
        return next;
      });
      if (!discovered.some((runtime) => runtime.reachable && runtime.models.length)) {
        setAgentError("No ready local models were detected. Start Ollama, the LM Studio local server, or llama.cpp, then retry discovery in Settings.");
      }
      return discovered;
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Local runtime discovery failed.");
      return [];
    } finally {
      setDiscoveringRuntimes(false);
    }
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      const result = await fetchTree();
      setTree(result.nodes);
      setWorkspacePath(result.root);
      return result.nodes;
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Could not read the workspace.");
      return [];
    }
  }, []);

  const openFile = useCallback(async (filePath: string, force = false) => {
    const existing = tabs.find((tab) => tab.path === filePath);
    if (existing && !force) {
      setActivePath(filePath);
      return;
    }
    setLoadingFile(true);
    try {
      const file = await fetchFile(filePath);
      setTabs((current) => existing
        ? current.map((tab) => tab.path === file.path ? file : tab)
        : [...current, file]);
      setDrafts((current) => ({ ...current, [file.path]: file.content }));
      setActivePath(file.path);
      setAgentError(undefined);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Could not open the file.");
    } finally {
      setLoadingFile(false);
    }
  }, [tabs]);

  useEffect(() => {
    void (async () => {
      const [nodes] = await Promise.all([refreshTree(), refreshRuntimes()]);
      const files = flattenFiles(nodes);
      const initial = files.find((file) => file.path === "src/client/App.tsx") || files.find((file) => file.path.endsWith(".md")) || files[0];
      if (initial) await openFile(initial.path);
    })();
    // Initial workspace bootstrap only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeTab = (filePath: string) => {
    const index = tabs.findIndex((tab) => tab.path === filePath);
    const remaining = tabs.filter((tab) => tab.path !== filePath);
    setTabs(remaining);
    setDrafts((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
    if (activePath === filePath) setActivePath(remaining[Math.max(0, index - 1)]?.path);
  };

  const saveActive = useCallback(async () => {
    if (!activeFile || !dirty) return;
    setSaveState("saving");
    try {
      const saved = await saveFile(activeFile, activeDraft);
      setTabs((current) => current.map((tab) => tab.path === saved.path ? saved : tab));
      setDrafts((current) => ({ ...current, [saved.path]: saved.content }));
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1300);
    } catch (error) {
      setSaveState("error");
      setAgentError(error instanceof Error ? error.message : "Save failed.");
    }
  }, [activeDraft, activeFile, dirty]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveActive]);

  const switchProvider = (kind: ProviderKind) => {
    const runtime = runtimes.find((item) => item.kind === kind);
    const next = {
      ...DEFAULTS[kind],
      endpoint: runtime?.endpoint || DEFAULTS[kind].endpoint,
      model: runtime?.models[0] || "",
      temperature: config.temperature,
    };
    setConfig(next);
    localStorage.setItem("forge.provider", JSON.stringify(next));
  };

  const openWorkspace = async () => {
    if (!window.forgeDesktop || dirty) {
      if (dirty) setAgentError("Save or close the modified editor tab before switching workspaces.");
      return;
    }
    const selected = await window.forgeDesktop.selectWorkspace();
    if (!selected) return;
    setTabs([]);
    setDrafts({});
    setActivePath(undefined);
    const nodes = await refreshTree();
    const files = flattenFiles(nodes);
    const initial = files.find((file) => file.path.toLowerCase() === "readme.md") || files[0];
    if (initial) await openFile(initial.path);
  };

  const startRun = async () => {
    if (!task.trim() || running) return;
    if (!config.model) {
      setAgentError("Select a detected local model before starting the agent.");
      setSettingsOpen(true);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setEvents([]);
    setAgentError(undefined);
    try {
      await streamAgentRun({ prompt: task.trim(), provider: config, maxRepairCycles: 1 }, (agentEvent) => {
        setEvents((current) => [...current, agentEvent]);
        if (agentEvent.kind === "promotion.complete") {
          void refreshTree();
          if (activePath && !dirty) setTimeout(() => void openFile(activePath, true), 200);
        }
      }, controller.signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setAgentError(error instanceof Error ? error.message : "Agent stream failed.");
      }
    } finally {
      setRunning(false);
      controllerRef.current = undefined;
    }
  };

  const beforeMount: BeforeMount = (monaco) => {
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    monaco.editor.defineTheme("forge-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "707080", fontStyle: "italic" },
        { token: "keyword", foreground: "c38cff" },
        { token: "string", foreground: "9ad7b0" },
        { token: "number", foreground: "efb177" },
        { token: "type.identifier", foreground: "75c8cf" },
      ],
      colors: {
        "editor.background": "#121116",
        "editor.foreground": "#dad8e1",
        "editorLineNumber.foreground": "#4d4b58",
        "editorLineNumber.activeForeground": "#a6a2af",
        "editorCursor.foreground": "#b47aff",
        "editor.selectionBackground": "#7042a04d",
        "editor.lineHighlightBackground": "#18171e",
        "editorIndentGuide.background1": "#24222c",
        "editorIndentGuide.activeBackground1": "#484352",
        "editorGutter.background": "#121116",
        "scrollbarSlider.background": "#5f596944",
        "scrollbarSlider.hoverBackground": "#77708066",
      },
    });
  };

  const breadcrumb = useMemo(() => activePath?.split("/") || [], [activePath]);

  return (
    <main className={`page-shell ${desktop ? "desktop" : ""}`}>
      <section className="ide-window">
        <header className="titlebar">
          <div className="window-dots"><span /><span /><span /></div>
          <div className="nav-controls"><button><ChevronLeft /></button><button><ChevronRight /></button></div>
          <button className="command-center"><Search /><span>Search files, symbols, or commands</span><kbd>Ctrl K</kbd></button>
          <div className="titlebar-actions">
            <div className="layout-controls">
              <button title="Toggle explorer" onClick={() => setExplorerOpen((value) => !value)}>{explorerOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
              <button title="Toggle agent" onClick={() => setAgentOpen((value) => !value)}>{agentOpen ? <PanelRightClose /> : <PanelRightOpen />}</button>
              <button title="Settings" onClick={() => { setSettingsOpen(true); void refreshRuntimes(); }}><Settings /></button>
            </div>
            {desktop && <div className="desktop-window-controls">
              <button aria-label="Minimize window" onClick={() => window.forgeDesktop?.windowAction("minimize")}><Minus /></button>
              <button aria-label="Maximize window" onClick={() => window.forgeDesktop?.windowAction("maximize")}><Square /></button>
              <button className="close" aria-label="Close window" onClick={() => window.forgeDesktop?.windowAction("close")}><X /></button>
            </div>}
          </div>
        </header>

        <div className="workbench">
          <nav className="activity-rail">
            <button className="brand-mark" title="Forge"><span><Sparkles /></span></button>
            <div className="activity-primary">
              <button className="active" title="Explorer"><Files /></button>
              <button title="Search"><Search /></button>
              <button title="Source control"><GitBranch /><i>0</i></button>
              <button title="Run and debug"><Bug /></button>
              <button title="Extensions"><Blocks /></button>
              <button title="Local agent"><Bot /></button>
            </div>
            <div className="activity-bottom">
              <button title="Security policy"><ShieldCheck /></button>
              <button title="Settings" onClick={() => { setSettingsOpen(true); void refreshRuntimes(); }}><Settings /></button>
            </div>
          </nav>

          {explorerOpen && (
            <Explorer nodes={tree} activePath={activePath} rootName={rootName} onOpen={(path) => void openFile(path)} onRefresh={() => void refreshTree()} onOpenWorkspace={desktop ? () => void openWorkspace() : undefined} />
          )}

          <section className="editor-pane">
            <EditorTabs tabs={tabs} activePath={activePath} drafts={drafts} onActivate={setActivePath} onClose={closeTab} />
            <div className="editor-breadcrumbs">
              {breadcrumb.map((part, index) => (
                <span key={`${part}-${index}`}><Code2 />{part}{index < breadcrumb.length - 1 && <ChevronRight />}</span>
              ))}
              <div className="breadcrumb-actions">
                <button className={dirty ? "save active" : "save"} onClick={() => void saveActive()} disabled={!dirty} title="Save file"><Save /></button>
                <button title="Run checks"><Play /></button>
                <button title="Maximize editor"><Maximize2 /></button>
              </div>
            </div>
            <div className="editor-surface">
              {activeFile ? (
                <Editor
                  height="100%"
                  path={activeFile.path}
                  language={activeFile.language}
                  value={activeDraft}
                  beforeMount={beforeMount}
                  theme="forge-dark"
                  onChange={(value) => setDrafts((current) => ({ ...current, [activeFile.path]: value ?? "" }))}
                  options={{
                    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
                    fontSize: 13.5,
                    lineHeight: 23,
                    minimap: { enabled: true, maxColumn: 80, scale: 0.75 },
                    padding: { top: 18, bottom: 24 },
                    smoothScrolling: true,
                    cursorSmoothCaretAnimation: "on",
                    wordWrap: "off",
                    renderLineHighlight: "all",
                    roundedSelection: true,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    guides: { bracketPairs: true, indentation: true },
                  }}
                />
              ) : (
                <div className="editor-empty">
                  {loadingFile ? <WandSparkles className="float-icon" /> : <Code2 />}
                  <h2>{loadingFile ? "Opening file…" : "Your workspace, under control"}</h2>
                  <p>Select a file from Explorer or ask the local agent to start a task.</p>
                </div>
              )}
            </div>
          </section>

          {agentOpen && (
            <AgentPanel
              events={events}
              running={running}
              config={config}
              task={task}
              error={agentError}
              runtime={activeRuntime}
              onTaskChange={setTask}
              onRun={() => void startRun()}
              onCancel={() => controllerRef.current?.abort()}
              onOpenSettings={() => { setSettingsOpen(true); void refreshRuntimes(); }}
              onProviderChange={switchProvider}
              onNewSession={() => { if (!running) { setEvents([]); setAgentError(undefined); setTask(""); } }}
            />
          )}
        </div>

        <footer className="statusbar">
          <div><span className="branch"><GitBranch /> main*</span><span><Check /> 0</span><span><X /> 0</span></div>
          <div>
            <span>{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : dirty ? "Modified" : "Synced"}</span>
            <span>{discoveringRuntimes ? "Detecting runtimes…" : activeRuntime?.reachable ? `${activeRuntime.label} · ${config.model || "no model"}` : "Runtime offline"}</span>
            <span>UTF-8</span><span>LF</span><span>{activeFile?.language || "Plain Text"}</span><span><Terminal /> {desktop ? "Desktop" : "Local"}</span>
          </div>
        </footer>
      </section>

      {settingsOpen && (
        <SettingsModal
          config={config}
          runtimes={runtimes}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            setConfig(next);
            localStorage.setItem("forge.provider", JSON.stringify(next));
            setSettingsOpen(false);
          }}
        />
      )}
    </main>
  );
}
