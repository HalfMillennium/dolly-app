/**
 * Headless preview-side renderer for the parity test (BUILD_PLAN §6.6). Drives the SAME
 * preview renderer the editor uses (apps/desktop/src/preview) against a project.json and a
 * decoded proxy frame, writing a PNG per (project, timestamp) for the Swift ParityTests to
 * diff against the export path.
 *
 * TODO(mac): this is wired up during the M6 export milestone. It needs:
 *   - a Node canvas backend (skia-canvas or @napi-rs/canvas) exposing CanvasRenderingContext2D
 *   - a proxy-frame decoder (extract the frame at time t as an ImageBitmap-like source)
 * Both are macOS/CI concerns; the shared math and the Swift side are already in place.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Project } from "@dolly/schema";

export interface ParitySample {
  projectPath: string;
  timestamps: number[]; // include mid-ramp times, not just steady state
  outDir: string;
  width: number;
  height: number;
}

export async function renderPreviewFrames(_sample: ParitySample): Promise<string[]> {
  // const project: Project = JSON.parse(readFileSync(_sample.projectPath, "utf8"));
  // const { createCanvas } = await import("@napi-rs/canvas");
  // const canvas = createCanvas(_sample.width, _sample.height);
  // const ctx = canvas.getContext("2d");
  // for (const t of _sample.timestamps) {
  //   const frame = await decodeProxyFrame(project.source.proxy, t);   // TODO(mac)
  //   drawPreviewFrame(ctx, project, frame, t, { exportMode: true });  // shared renderer
  //   const png = canvas.toBuffer("image/png");
  //   const path = `${_sample.outDir}/preview-${t.toFixed(3)}.png`;
  //   writeFileSync(path, png);
  // }
  void readFileSync;
  void writeFileSync;
  throw new Error("render-preview.ts is a TODO(mac) skeleton — see scripts/parity/README.md");
}

// Keep the type import load-bearing so this file stays in sync with the schema.
export type { Project };
