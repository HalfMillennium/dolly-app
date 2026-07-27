/**
 * Optional AI-director client (Cursorcraft §4).
 *
 * Thin wrapper over the Tauri `optimize_director` command, which lives in the Rust shell so the
 * user's Claude API key stays out of the webview. Given the privacy-preserving interaction
 * summary (coordinates + timing only), the command calls the Claude API and returns a BeatPlan.
 * This is opt-in: `directorAvailable()` reports whether a key is configured, and every failure
 * falls back to the local (offline) optimizer.
 */
import { invoke } from "@tauri-apps/api/core";
import type { BeatPlan } from "@dolly/cursoropt";

export interface DirectorSummary {
  targets: Array<{ t: number; x: number; y: number; click: boolean; score: number }>;
  duration: number;
}

/** True when the user has configured a Claude API key for the director. */
export async function directorAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("director_available");
  } catch {
    return false;
  }
}

/** Ask the director for a beat plan. Throws if the command is unavailable or the call fails. */
export async function optimizeDirector(summary: DirectorSummary): Promise<BeatPlan> {
  return await invoke<BeatPlan>("optimize_director", { summary });
}
