/**
 * DOLLY background service worker (MV3).
 *
 * Responsibilities:
 *  - own the recording session (steps stream in from the content script) and mirror it into
 *    chrome.storage.local, because the worker can be torn down at any time;
 *  - start/stop tab video capture for "watch" mode (via an offscreen document that runs the
 *    MediaRecorder — a service worker has no DOM and cannot host one directly);
 *  - persist the finished Recording and hand JSON/webm to the downloads API.
 *
 * Video capture is best-effort: if tabCapture is unavailable the step log is still recorded
 * (the log always drives live replay; the video only enriches watch mode).
 */
import type { Recording } from "@dolly/schema";
import { SESSION_KEY, STORAGE_KEY, type Msg, type Session, type StateReply } from "../protocol.js";

const EMPTY: Session = {
  recording: false,
  startedAt: 0,
  tabId: null,
  startUrl: "",
  viewport: { w: 0, h: 0 },
  steps: [],
};

async function loadSession(): Promise<Session> {
  const got = await chrome.storage.local.get(SESSION_KEY);
  return (got[SESSION_KEY] as Session | undefined) ?? { ...EMPTY };
}
async function saveSession(s: Session): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: s });
}

async function startRecording(tabId: number): Promise<void> {
  const session: Session = { ...EMPTY, recording: true, startedAt: Date.now(), tabId, steps: [] };
  await saveSession(session);
  // Tell the content script to begin emitting steps.
  try {
    await chrome.tabs.sendMessage(tabId, { type: "REC_STARTED" } satisfies Msg);
  } catch {
    // content script may not be injected on this page (e.g. chrome://) — step log stays empty.
  }
  void startVideo(tabId).catch(() => void 0);
}

async function stopRecording(): Promise<Session> {
  const session = await loadSession();
  session.recording = false;
  await saveSession(session);
  if (session.tabId != null) {
    try {
      await chrome.tabs.sendMessage(session.tabId, { type: "REC_STOPPED" } satisfies Msg);
    } catch {
      /* tab gone */
    }
  }
  await stopVideo();
  return session;
}

// --- video capture via an offscreen document ------------------------------------------------
async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen?.hasDocument?.();
  if (has) return;
  await chrome.offscreen?.createDocument?.({
    url: "src/offscreen/offscreen.html",
    reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
    justification: "Record the captured tab stream to a webm for walkthrough playback.",
  });
}

function getMediaStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err || !streamId) reject(err ?? new Error("no stream id"));
      else resolve(streamId);
    });
  });
}

async function startVideo(tabId: number): Promise<void> {
  if (!chrome.tabCapture?.getMediaStreamId) return;
  await ensureOffscreen();
  const streamId = await getMediaStreamId(tabId);
  chrome.runtime.sendMessage({ type: "OFFSCREEN_START", streamId });
}
async function stopVideo(): Promise<void> {
  chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" });
}

async function persistRecording(recording: Recording): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: recording });
}

type InternalMsg = Msg | { type: "OFFSCREEN_BLOB"; url?: string };

chrome.runtime.onMessage.addListener((msg: InternalMsg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "START": {
        await startRecording((msg as Extract<Msg, { type: "START" }>).tabId);
        sendResponse({ ok: true });
        break;
      }
      case "STOP": {
        const session = await stopRecording();
        sendResponse({ ok: true, session });
        break;
      }
      case "GET_STATE": {
        const session = await loadSession();
        const got = await chrome.storage.local.get(STORAGE_KEY);
        const reply: StateReply = {
          session: session.recording || session.steps.length ? session : null,
          recording: (got[STORAGE_KEY] as Recording | undefined) ?? null,
        };
        sendResponse(reply);
        break;
      }
      case "STEP": {
        const m = msg as Extract<Msg, { type: "STEP" }>;
        const session = await loadSession();
        if (!session.recording) break;
        if (!session.startUrl) session.startUrl = m.startUrl;
        session.viewport = m.viewport;
        session.steps.push(m.step);
        await saveSession(session);
        break;
      }
      case "SAVE": {
        await persistRecording((msg as Extract<Msg, { type: "SAVE" }>).recording);
        sendResponse({ ok: true });
        break;
      }
      case "CLEAR": {
        await chrome.storage.local.remove([SESSION_KEY, STORAGE_KEY]);
        sendResponse({ ok: true });
        break;
      }
      // messages from the offscreen doc reporting the finished blob
      case "OFFSCREEN_BLOB": {
        const url = (msg as { url?: string }).url;
        if (url) {
          const session = await loadSession();
          session.videoUrl = url;
          await saveSession(session);
        }
        break;
      }
      default:
        break;
    }
  })();
  return true; // keep the message channel open for the async response
});
