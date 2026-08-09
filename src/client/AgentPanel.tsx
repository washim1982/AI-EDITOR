import { useMemo, useState } from "react";
import {
  ArrowUp,
  Bot,
  Braces,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  FileCheck2,
  GitCompareArrows,
  ListTree,
  LoaderCircle,
  Plus,
  RotateCcw,
  SearchCode,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  X,
  XCircle,
} from "lucide-react";
import type { AgentEvent, ProviderConfig, ProviderKind, RuntimeStatus } from "../shared/types";

interface AgentPanelProps {
  events: AgentEvent[];
  running: boolean;
  config: ProviderConfig;
  task: string;
  error?: string;
  runtime?: RuntimeStatus;
  onTaskChange: (value: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onProviderChange: (kind: ProviderKind) => void;
  onNewSession: () => void;
}

function phaseIcon(event: AgentEvent) {
  if (event.status === "error") return <XCircle />;
  if (event.status === "running") return <LoaderCircle className="spinning" />;
  if (event.kind === "snapshot.created") return <GitCompareArrows />;
  if (event.phase === "gather") return <SearchCode />;
  if (event.phase === "apply") return <Braces />;
  if (event.phase === "verify") return <TerminalSquare />;
  if (event.phase === "promote") return <ShieldCheck />;
  return <Check />;
}

function TimelineEvent({ event, last }: { event: AgentEvent; last: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = Boolean(event.data && Object.keys(event.data).length);
  return (
    <div className={`timeline-event ${event.status}`}>
      <div className="timeline-rail">
        <span className="timeline-icon">{phaseIcon(event)}</span>
        {!last && <span className="timeline-line" />}
      </div>
      <div className="event-body">
        <button className="event-summary" onClick={() => hasData && setExpanded((value) => !value)}>
          <span className="event-title">{event.title}</span>
          <span className="event-time">{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="event-message">{event.message}</span>
          {hasData && <ChevronDown className={expanded ? "expanded" : ""} />}
        </button>
        {expanded && <pre className="event-data">{JSON.stringify(event.data, null, 2)}</pre>}
      </div>
    </div>
  );
}

function EmptySession() {
  return (
    <div className="empty-session">
      <div className="empty-orbit"><Sparkles /><span /></div>
      <h3>Build with your local model</h3>
      <p>Forge separates repository research from mutation, verifies changes in isolation, then promotes only a passing patch.</p>
      <div className="architecture-mini">
        <span><SearchCode /> Gather</span>
        <i />
        <span><FileCheck2 /> Brief</span>
        <i />
        <span><Braces /> Apply</span>
      </div>
      <div className="safety-note"><ShieldCheck /> Workspace writes are staged and CAS-protected</div>
    </div>
  );
}

export function AgentPanel({
  events,
  running,
  config,
  task,
  error,
  runtime,
  onTaskChange,
  onRun,
  onCancel,
  onOpenSettings,
  onProviderChange,
  onNewSession,
}: AgentPanelProps) {
  const lastEventId = events.at(-1)?.id;
  const statusLabel = useMemo(() => {
    if (running) return "Autopilot running";
    if (events.at(-1)?.kind === "run.completed") return "Task complete";
    if (events.at(-1)?.kind === "run.failed") return "Stopped safely";
    return "Ready";
  }, [events, running]);

  return (
    <aside className="agent-panel">
      <header className="agent-header">
        <div className="session-tab"><CircleDot /><span>Agent</span><X /></div>
        <div className="agent-actions">
          <button title="New session" onClick={onNewSession}><Plus /></button>
          <button title="Run history"><ListTree /></button>
          <button title="Settings" onClick={onOpenSettings}><Settings2 /></button>
        </div>
      </header>
      <div className="agent-statusbar">
        <span className={`status-pulse ${running ? "live" : ""}`} />
        <span>{statusLabel}</span>
        <span className="context-badge">2-phase</span>
      </div>
      <div className="agent-scroll">
        {events.length === 0 ? <EmptySession /> : events.map((item) => (
          <TimelineEvent key={item.id} event={item} last={item.id === lastEventId} />
        ))}
        {error && <div className="inline-error"><XCircle />{error}</div>}
      </div>
      {running && (
        <div className="working-strip">
          <span><LoaderCircle className="spinning" /> Working in isolation…</span>
          <button onClick={onCancel}>Cancel</button>
        </div>
      )}
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={task}
            onChange={(event) => onTaskChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onRun();
            }}
            placeholder="Ask Forge to build, fix, or refactor…"
            rows={3}
          />
          <div className="composer-toolbar">
            <div className="provider-switch">
              <span className={`runtime-dot ${runtime?.reachable && runtime.models.length ? "online" : "offline"}`} />
              <Bot />
              <select value={config.kind} onChange={(event) => onProviderChange(event.target.value as ProviderKind)}>
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
                <option value="llamacpp">llama.cpp</option>
              </select>
              <ChevronDown />
              <span className="model-name">{config.model || (runtime?.reachable ? "No models" : "Runtime offline")}</span>
            </div>
            <button
              className={`send-button ${task.trim() ? "enabled" : ""}`}
              disabled={(!task.trim() || !config.model) && !running}
              onClick={running ? onCancel : onRun}
              aria-label={running ? "Stop agent" : "Run agent"}
            >
              {running ? <Square /> : <ArrowUp />}
            </button>
          </div>
        </div>
        <div className="composer-caption">Ctrl ↵ to run · local inference only</div>
      </div>
    </aside>
  );
}
