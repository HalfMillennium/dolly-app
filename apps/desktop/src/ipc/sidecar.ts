/**
 * Typed sidecar client (BUILD_PLAN §3.4).
 *
 * The Swift capture/export daemon (`dollyd`) is owned by the Rust core; the frontend never
 * touches stdin/stdout directly. Instead the Rust side exposes Tauri commands (request/
 * response) and emits Tauri events (the telemetry/progress stream). This module mirrors the
 * §3.4 protocol as typed async methods over a thin `SidecarTransport` seam so it can be
 * mocked in tests / on non-macOS hosts.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import type {
  CaptureTarget,
  DisplayInfo,
  ExportPreset,
  Quality,
  SidecarEvent,
  WindowInfo,
} from "@dolly/schema";

/** The seam the client talks through. Swap the implementation to mock the sidecar. */
export interface SidecarTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

/** Default transport backed by Tauri IPC (BUILD_PLAN §2.2). */
export const tauriTransport: SidecarTransport = {
  invoke: <T,>(command: string, args?: Record<string, unknown>) =>
    invoke<T>(command, args),
  listen: async <T,>(event: string, handler: (payload: T) => void) => {
    const unlisten = await listen<T>(event, (e: TauriEvent<T>) => handler(e.payload));
    return unlisten;
  },
};

// Tauri command + event names the Rust core is expected to register.
const CMD = {
  listSources: "sidecar_list_sources",
  start: "sidecar_start",
  stop: "sidecar_stop",
  export: "sidecar_export",
  ping: "sidecar_ping",
} as const;

const EV = {
  recording: "sidecar://recording",
  exportProgress: "sidecar://export-progress",
  error: "sidecar://error",
} as const;

export interface ListSourcesResult {
  displays: DisplayInfo[];
  windows: WindowInfo[];
}

export interface StartOptions {
  target: CaptureTarget;
  quality: Quality;
  mic?: string | null;
  systemAudio: boolean;
  detectTyping?: boolean;
  out: string;
}

export interface ExportOptions {
  project: string;
  out: string;
  preset: ExportPreset;
}

export interface ExportResult {
  path: string;
  bytes: number;
}

export type SidecarEventHandler = (event: SidecarEvent) => void;

export class SidecarClient {
  constructor(private readonly transport: SidecarTransport = tauriTransport) {}

  listSources(): Promise<ListSourcesResult> {
    return this.transport.invoke<ListSourcesResult>(CMD.listSources);
  }

  start(options: StartOptions): Promise<void> {
    return this.transport.invoke<void>(CMD.start, { options });
  }

  stop(): Promise<void> {
    return this.transport.invoke<void>(CMD.stop);
  }

  export(options: ExportOptions): Promise<ExportResult> {
    return this.transport.invoke<ExportResult>(CMD.export, { options });
  }

  ping(): Promise<{ ok: true }> {
    return this.transport.invoke<{ ok: true }>(CMD.ping);
  }

  /**
   * Subscribe to the sidecar event stream (recording ticks, export progress, errors).
   * Returns an unsubscribe that detaches every underlying listener.
   */
  async onEvent(handler: SidecarEventHandler): Promise<() => void> {
    const unsubs = await Promise.all([
      this.transport.listen<{ t: number; dropped: number }>(EV.recording, (p) =>
        handler({ ev: "recording", t: p.t, dropped: p.dropped }),
      ),
      this.transport.listen<{ p: number; fps: number }>(EV.exportProgress, (p) =>
        handler({ ev: "exportProgress", p: p.p, fps: p.fps }),
      ),
      this.transport.listen<{ code: string; msg: string }>(EV.error, (p) =>
        handler({ ev: "error", code: p.code, msg: p.msg }),
      ),
    ]);
    return () => {
      for (const u of unsubs) u();
    };
  }
}

/** Shared default instance. */
export const sidecar = new SidecarClient();
