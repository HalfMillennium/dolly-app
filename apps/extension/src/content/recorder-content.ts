/**
 * DOLLY content recorder. Injected into the page; when the background worker says a session has
 * started, it installs the DOM recorder (`@dolly/recorder`'s `attach`) and streams each mapped
 * Step to the background. A small fixed HUD shows recording status and step count.
 *
 * Privacy: `attach` → `mapEventToStep` already masks password/autocomplete/[data-dolly-secret]
 * values and records only navigation keystrokes (rhythm), never secret content.
 */
import { attach } from "@dolly/recorder";
import type { Step } from "@dolly/schema";
import type { Msg } from "../protocol.js";

let detach: (() => void) | null = null;
let count = 0;
let hud: HTMLDivElement | null = null;

function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

function showHud(): void {
  if (hud) return;
  hud = document.createElement("div");
  hud.setAttribute("data-dolly-hud", "");
  hud.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "left:16px",
    "bottom:16px",
    "display:flex",
    "align-items:center",
    "gap:8px",
    "padding:8px 14px",
    "border-radius:999px",
    "background:#111827",
    "color:#f9fafb",
    "font:600 13px system-ui,sans-serif",
    "box-shadow:0 6px 24px rgba(0,0,0,0.35)",
    "pointer-events:none",
  ].join(";");
  hud.innerHTML =
    '<span style="width:10px;height:10px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 0 rgba(239,68,68,0.6);animation:dolly-pulse 1.2s infinite"></span>' +
    '<span data-dolly-label>DOLLY recording · 0 steps</span>';
  const style = document.createElement("style");
  style.textContent =
    "@keyframes dolly-pulse{0%{box-shadow:0 0 0 0 rgba(239,68,68,0.6)}70%{box-shadow:0 0 0 10px rgba(239,68,68,0)}100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}}";
  hud.appendChild(style);
  document.documentElement.appendChild(hud);
}

function updateHud(): void {
  const label = hud?.querySelector("[data-dolly-label]");
  if (label) label.textContent = `DOLLY recording · ${count} step${count === 1 ? "" : "s"}`;
}

function hideHud(): void {
  hud?.remove();
  hud = null;
}

function startRecording(): void {
  if (detach) return;
  count = 0;
  showHud();
  detach = attach(document, (step: Step) => {
    count += 1;
    updateHud();
    const msg: Msg = { type: "STEP", step, startUrl: location.href, viewport: viewport() };
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      /* worker asleep; storage mirror in the worker will catch up on the next message */
    }
  });
}

function stopRecording(): void {
  detach?.();
  detach = null;
  hideHud();
}

chrome.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.type === "REC_STARTED") startRecording();
  else if (msg.type === "REC_STOPPED") stopRecording();
});

// If the page (re)loads mid-session, resume the HUD/recorder from persisted state.
chrome.runtime.sendMessage({ type: "GET_STATE" } satisfies Msg, (reply) => {
  if (chrome.runtime.lastError) return;
  if (reply?.session?.recording) startRecording();
});
