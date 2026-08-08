/**
 * The message contract between the popup, background service worker, and content recorder.
 * One discriminated union so both ends stay in sync; the service worker is the source of truth
 * for session state (it is ephemeral, so it also mirrors state into chrome.storage.local).
 */
import type { Recording, Step } from "@dolly/schema";

export const STORAGE_KEY = "dolly.recording";
export const SESSION_KEY = "dolly.session";

/** Live recording session, persisted so it survives a service-worker restart. */
export interface Session {
  recording: boolean;
  startedAt: number;
  tabId: number | null;
  startUrl: string;
  viewport: { w: number; h: number };
  steps: Step[];
  videoUrl?: string;
}

export type Msg =
  // popup → background
  | { type: "START"; tabId: number }
  | { type: "STOP" }
  | { type: "GET_STATE" }
  | { type: "SAVE"; recording: Recording }
  | { type: "CLEAR" }
  // content → background
  | { type: "STEP"; step: Step; startUrl: string; viewport: { w: number; h: number } }
  // background → content
  | { type: "REC_STARTED" }
  | { type: "REC_STOPPED" };

export type StateReply = { session: Session | null; recording: Recording | null };
