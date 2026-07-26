/**
 * TypeScript mirror of the DOLLY data contracts (BUILD_PLAN §3).
 *
 * The JSON Schemas in `schema/` are the source of truth. In CI, `scripts/gen-ts.ts`
 * regenerates this file from them and `scripts/gen-swift.sh` regenerates the Swift Codable
 * structs — hand-maintaining divergent copies is how preview/export drift starts
 * (BUILD_PLAN §4). The committed copy here is kept in sync with the schema and guarded by
 * `test/schema-valid.test.ts`, which validates the §3 example documents against the schema.
 */

// --- cursor.jsonl (§3.2) ---------------------------------------------------------------

export type CursorEventKind = "move" | "down" | "up" | "drag" | "scroll" | "key";
export type MouseButton = "left" | "right" | "other";

export interface CursorEvent {
  /** seconds, float, relative to the PTS of the first written video frame (§3.2, §5.3) */
  t: number;
  /** normalized [0,1] against the captured surface, origin top-left. Absent for `key`. */
  x?: number;
  y?: number;
  e: CursorEventKind;
  /** button for down/up/drag */
  b?: MouseButton;
  /** scroll delta */
  dy?: number;
}

// --- project.json (§3.3) ---------------------------------------------------------------

export interface Source {
  master: string;
  proxy: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  scale: number;
}

export type AudioRole = "system" | "mic";

export interface AudioTrack {
  file: string;
  role: AudioRole;
  gain: number;
  muted: boolean;
}

export interface Trim {
  in: number;
  out: number;
}

export interface GradientBackdrop {
  type: "gradient";
  from: string;
  to: string;
  angle: number;
}

export interface SolidBackdrop {
  type: "solid";
  color: string;
}

export type Backdrop = GradientBackdrop | SolidBackdrop;

export interface Shadow {
  enabled: boolean;
  opacity: number;
  blur: number;
  y: number;
}

export interface Composition {
  backdrop: Backdrop;
  padding: number;
  radius: number;
  shadow: Shadow;
}

export interface CursorStyle {
  visible: boolean;
  size: number;
  smoothing: number;
  clickRipple: boolean;
  hideWhenIdle: number;
}

export type FocalMode = "fixed" | "follow";
export type ZoomOrigin = "auto" | "manual";
export type ZoomEasing = "cubicInOut" | "cubicOut" | "linear";

export interface FixedFocal {
  mode: "fixed";
  x: number;
  y: number;
}

export interface FollowFocal {
  mode: "follow";
  damping: number;
  track: "cursor";
}

export type ZoomFocal = FixedFocal | FollowFocal;

export interface Zoom {
  id: string;
  start: number;
  end: number;
  scale: number;
  focal: ZoomFocal;
  rampIn: number;
  rampOut: number;
  easing: ZoomEasing;
  origin: ZoomOrigin;
}

export interface SpeedSegment {
  start: number;
  end: number;
  rate: number;
}

export interface AutoZoomMeta {
  lastRunParams: Record<string, unknown>;
  generatedAt: string;
}

export interface Project {
  version: 1;
  source: Source;
  audio: AudioTrack[];
  trim: Trim;
  composition: Composition;
  cursor: CursorStyle;
  zooms: Zoom[];
  speed: SpeedSegment[];
  autoZoom?: AutoZoomMeta;
}

// --- sidecar protocol (§3.4) -----------------------------------------------------------

export type Quality = "studio" | "quick";
export type ExportPreset = "h264-1080p" | "h264-4k" | "hevc-4k" | "gif-720p";

export interface TargetDisplay {
  kind: "display";
  id: number;
}
export interface TargetWindow {
  kind: "window";
  id: number;
}
export interface TargetRegion {
  kind: "region";
  display: number;
  rect: { x: number; y: number; w: number; h: number };
}
export type CaptureTarget = TargetDisplay | TargetWindow | TargetRegion;

export interface ReqListSources {
  id: number;
  cmd: "listSources";
}
export interface ReqStart {
  id: number;
  cmd: "start";
  target: CaptureTarget;
  quality: Quality;
  mic?: string | null;
  systemAudio: boolean;
  detectTyping?: boolean;
  out: string;
}
export interface ReqStop {
  id: number;
  cmd: "stop";
}
export interface ReqExport {
  id: number;
  cmd: "export";
  project: string;
  out: string;
  preset: ExportPreset;
}
export interface ReqPing {
  id: number;
  cmd: "ping";
}
export type SidecarRequest =
  | ReqListSources
  | ReqStart
  | ReqStop
  | ReqExport
  | ReqPing;

export interface DisplayInfo {
  id: number;
  width: number;
  height: number;
  scale: number;
  name: string;
}
export interface WindowInfo {
  id: number;
  app: string;
  title: string;
  frame: { x: number; y: number; w: number; h: number };
  thumb?: string;
}

export interface RespOk {
  id: number;
  ok: true;
  [k: string]: unknown;
}
export interface RespErr {
  id: number;
  ok: false;
  code: string;
  msg: string;
}
export type SidecarResponse = RespOk | RespErr;

export interface EvRecording {
  ev: "recording";
  t: number;
  dropped: number;
}
export interface EvExportProgress {
  ev: "exportProgress";
  p: number;
  fps: number;
}
export interface EvError {
  ev: "error";
  code: string;
  msg: string;
}
export type SidecarEvent = EvRecording | EvExportProgress | EvError;

export type SidecarMessage = SidecarResponse | SidecarEvent;
