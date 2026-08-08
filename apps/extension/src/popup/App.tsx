/**
 * DOLLY popup — the authoring editor.
 *
 * Flow: Record → the content script streams steps into the session → Stop pulls the session into
 * the editor store → review/annotate (caption, per-step live mode, mark destructive, reorder,
 * delete) → Export the Recording JSON and copy an embed snippet for the product team.
 */
import React, { useEffect, useState } from "react";
import type { LiveMode, StepAction } from "@dolly/schema";
import type { Msg, StateReply } from "../protocol.js";
import { useEditor } from "./store.js";

function send<T = unknown>(msg: Msg): Promise<T> {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r as T)));
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

const ACTION_ICON: Record<StepAction, string> = {
  click: "👆",
  dblclick: "👆👆",
  input: "⌨️",
  change: "⌨️",
  submit: "✅",
  scroll: "↕️",
  navigate: "🧭",
  hover: "🖱️",
  keypress: "⏎",
  wait: "⏳",
};

export function App(): React.ReactElement {
  const ed = useEditor();
  const [recording, setRecording] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void send<StateReply>({ type: "GET_STATE" }).then((state) => {
      if (!state) return;
      setRecording(Boolean(state.session?.recording));
      if (state.session && state.session.steps.length) {
        ed.load({
          title: state.recording?.title,
          startUrl: state.session.startUrl,
          viewport: state.session.viewport,
          steps: state.session.steps,
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(): Promise<void> {
    const tabId = await activeTabId();
    if (tabId == null) return;
    await send({ type: "START", tabId });
    setRecording(true);
  }

  async function stop(): Promise<void> {
    const reply = await send<{ session?: { startUrl: string; viewport: { w: number; h: number }; steps: [] } }>(
      { type: "STOP" },
    );
    setRecording(false);
    if (reply?.session) {
      ed.load({
        startUrl: reply.session.startUrl,
        viewport: reply.session.viewport,
        steps: reply.session.steps,
      });
    }
  }

  function exportJson(): void {
    const rec = ed.toRecording();
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    void chrome.downloads.download({ url, filename: `${slug(rec.title)}.dolly.json` });
    void send({ type: "SAVE", recording: rec });
  }

  async function copyEmbed(): Promise<void> {
    const rec = ed.toRecording();
    const snippet = embedSnippet(JSON.stringify(rec));
    await navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const selected = ed.steps.find((s) => s.id === ed.selected) ?? null;

  return (
    <div style={S.root}>
      <header style={S.header}>
        <strong style={{ fontSize: 15 }}>DOLLY</strong>
        <span style={S.sub}>walkthrough recorder</span>
      </header>

      <div style={S.controls}>
        {recording ? (
          <button style={{ ...S.btn, ...S.stop }} onClick={() => void stop()}>
            ■ Stop recording
          </button>
        ) : (
          <button style={{ ...S.btn, ...S.rec }} onClick={() => void start()}>
            ● Record
          </button>
        )}
        <span style={S.count}>{ed.steps.length} steps</span>
      </div>

      {!recording && ed.steps.length > 0 && (
        <>
          <label style={S.field}>
            <span style={S.label}>Title</span>
            <input style={S.input} value={ed.title} onChange={(e) => ed.setTitle(e.target.value)} />
          </label>

          <label style={S.field}>
            <span style={S.label}>Live default</span>
            <select
              style={S.input}
              value={ed.liveDefault}
              onChange={(e) => ed.setLiveDefault(e.target.value as "auto" | "coach")}
            >
              <option value="coach">Coach (guide the user)</option>
              <option value="auto">Auto-run (perform actions)</option>
            </select>
          </label>

          <div style={S.listWrap}>
            {ed.steps.map((step, i) => (
              <div
                key={step.id}
                style={{ ...S.stepRow, ...(step.id === ed.selected ? S.stepSel : null) }}
                onClick={() => ed.select(step.id)}
              >
                <span>{ACTION_ICON[step.action]}</span>
                <span style={S.stepText}>
                  {step.caption || `${step.action}${step.value ? ` "${trunc(step.value)}"` : ""}`}
                </span>
                {step.destructive && <span title="destructive" style={S.warn}>⚠</span>}
                <span style={S.stepNo}>{i + 1}</span>
              </div>
            ))}
          </div>

          {selected && (
            <div style={S.inspector}>
              <div style={S.label}>Step {ed.steps.indexOf(selected) + 1}: {selected.action}</div>
              <input
                style={S.input}
                placeholder="Caption shown to the viewer…"
                value={selected.caption ?? ""}
                onChange={(e) => ed.setCaption(selected.id, e.target.value)}
              />
              <div style={S.row}>
                <select
                  style={{ ...S.input, flex: 1 }}
                  value={selected.liveMode ?? "inherit"}
                  onChange={(e) => ed.setLiveMode(selected.id, e.target.value as LiveMode)}
                >
                  <option value="inherit">Live: default</option>
                  <option value="auto">Live: auto-run</option>
                  <option value="coach">Live: coach</option>
                </select>
                <label style={S.check}>
                  <input
                    type="checkbox"
                    checked={Boolean(selected.destructive)}
                    onChange={() => ed.toggleDestructive(selected.id)}
                  />
                  destructive
                </label>
              </div>
              <div style={S.row}>
                <button style={S.smallBtn} onClick={() => ed.move(selected.id, -1)}>↑</button>
                <button style={S.smallBtn} onClick={() => ed.move(selected.id, 1)}>↓</button>
                <button style={{ ...S.smallBtn, marginLeft: "auto" }} onClick={() => ed.remove(selected.id)}>
                  Delete
                </button>
              </div>
            </div>
          )}

          <div style={S.footer}>
            <button style={S.smallBtn} onClick={() => ed.undo()} disabled={!ed.past.length}>
              Undo
            </button>
            <button style={S.smallBtn} onClick={() => ed.redo()} disabled={!ed.future.length}>
              Redo
            </button>
            <button style={{ ...S.btn, ...S.primary, marginLeft: "auto" }} onClick={exportJson}>
              Export JSON
            </button>
            <button style={{ ...S.btn, ...S.primary }} onClick={() => void copyEmbed()}>
              {copied ? "Copied!" : "Copy embed"}
            </button>
          </div>
        </>
      )}

      {!recording && ed.steps.length === 0 && (
        <p style={S.hint}>Press Record, click through your web app, then Stop to review the steps.</p>
      )}
    </div>
  );
}

function trunc(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "walkthrough";
}
function embedSnippet(recordingJson: string): string {
  return [
    `<script type="module" src="https://unpkg.com/@dolly/player/dist/index.js"></script>`,
    `<dolly-walkthrough id="dolly" live-default="coach"></dolly-walkthrough>`,
    `<script type="module">`,
    `  import { registerWalkthroughElement } from "https://unpkg.com/@dolly/player";`,
    `  registerWalkthroughElement();`,
    `  document.getElementById("dolly").recording = ${recordingJson};`,
    `</script>`,
  ].join("\n");
}

const S: Record<string, React.CSSProperties> = {
  root: { font: "13px system-ui, sans-serif", color: "#0f172a", padding: 12, boxSizing: "border-box" },
  header: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 },
  sub: { color: "#64748b", fontSize: 12 },
  controls: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  btn: { font: "inherit", fontWeight: 600, padding: "7px 14px", borderRadius: 8, border: "1px solid #cbd5e1", cursor: "pointer", background: "#fff" },
  rec: { background: "#dc2626", color: "#fff", borderColor: "#dc2626" },
  stop: { background: "#111827", color: "#fff", borderColor: "#111827" },
  primary: { background: "#2563eb", color: "#fff", borderColor: "#2563eb" },
  count: { color: "#64748b", marginLeft: "auto" },
  field: { display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 },
  label: { fontSize: 11, fontWeight: 600, color: "#475569", textTransform: "uppercase", letterSpacing: 0.4 },
  input: { font: "inherit", padding: "6px 8px", borderRadius: 6, border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" },
  listWrap: { maxHeight: 180, overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: 8, margin: "4px 0" },
  stepRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderBottom: "1px solid #f1f5f9", cursor: "pointer" },
  stepSel: { background: "#eff6ff" },
  stepText: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  stepNo: { color: "#94a3b8", fontSize: 11 },
  warn: { color: "#d97706" },
  inspector: { display: "flex", flexDirection: "column", gap: 6, padding: 8, background: "#f8fafc", borderRadius: 8, margin: "6px 0" },
  row: { display: "flex", alignItems: "center", gap: 8 },
  check: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#475569" },
  smallBtn: { font: "inherit", padding: "4px 10px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" },
  footer: { display: "flex", alignItems: "center", gap: 6, marginTop: 8 },
  hint: { color: "#64748b", lineHeight: 1.5 },
};
