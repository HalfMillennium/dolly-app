/**
 * Stage (BUILD_PLAN §6.2, §6.3).
 *
 * Hosts the hidden <video src=proxy>, the <canvas> preview driven by requestVideoFrameCallback,
 * and two <audio> elements resynced when they drift > 50ms from the video. Each presented
 * frame is handed to the preview renderer. Clicking the stage picks a focal point for the
 * selected (or active) zoom.
 */
import { useEffect, useRef } from "react";
import { contentRect } from "@dolly/schema/math";
import { useEditor, zoomAt } from "../state/store";
import {
  createPreviewState,
  renderPreview,
  type PreviewState,
} from "../preview/renderer";

const SYNC_THRESHOLD = 0.05; // §6.2

export function Stage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sysAudioRef = useRef<HTMLAudioElement | null>(null);
  const micAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewState = useRef<PreviewState>(createPreviewState());
  const rafId = useRef<number | null>(null);

  const project = useEditor((s) => s.project);
  const playing = useEditor((s) => s.playing);

  // Drive the render loop. We read the freshest store state via getState() inside the loop so
  // the callback doesn't need to be recreated on every playhead change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let stopped = false;

    const present = (): void => {
      if (stopped) return;
      const st = useEditor.getState();
      const proj = st.project;
      if (!proj) return;

      // media time: prefer the real video, fall back to the store playhead (no proxy here).
      const time =
        video && video.readyState >= 2 && !Number.isNaN(video.currentTime)
          ? video.currentTime
          : st.playhead;

      if (video && video.readyState >= 2) {
        // keep the store playhead in step with presented frames while playing
        if (st.playing && Math.abs(st.playhead - time) > 1e-3) {
          useEditor.getState().setPlayhead(time);
        }
        resyncAudio(sysAudioRef.current, video);
        resyncAudio(micAudioRef.current, video);
      }

      sizeCanvas(canvas);
      renderPreview(ctx, {
        project: proj,
        time,
        video: video && video.readyState >= 2 ? video : null,
        width: canvas.width,
        height: canvas.height,
        cursor: st.cursor,
        state: previewState.current,
        selectedZoomId: st.selectedZoomId,
      });
    };

    const useRvfc =
      video && typeof video.requestVideoFrameCallback === "function";

    const loop = (): void => {
      present();
      if (stopped) return;
      if (useRvfc && video) {
        video.requestVideoFrameCallback(() => loop());
      } else {
        rafId.current = requestAnimationFrame(loop);
      }
    };
    loop();

    return () => {
      stopped = true;
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, [project?.source.proxy]);

  // play / pause the media elements from the store flag
  useEffect(() => {
    const video = videoRef.current;
    const audios = [sysAudioRef.current, micAudioRef.current];
    if (playing) {
      void video?.play().catch(() => undefined);
      for (const a of audios) void a?.play().catch(() => undefined);
    } else {
      video?.pause();
      for (const a of audios) a?.pause();
    }
  }, [playing]);

  // seek the video when the playhead is moved externally (scrub) while paused
  const playhead = useEditor((s) => s.playhead);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || playing) return;
    if (Math.abs(video.currentTime - playhead) > 0.02 && video.readyState >= 1) {
      video.currentTime = playhead;
    }
  }, [playhead, playing]);

  const onPick = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    const proj = useEditor.getState().project;
    if (!canvas || !proj) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const aspect = proj.source.width / proj.source.height;
    const content = contentRect(canvas.width, canvas.height, aspect, proj.composition.padding);
    const fx = (px - content.x) / content.w;
    const fy = (py - content.y) / content.h;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;

    const st = useEditor.getState();
    const target =
      (st.selectedZoomId && proj.zooms.find((z) => z.id === st.selectedZoomId)) ||
      zoomAt(proj, st.playhead);
    if (!target) return;
    st.updateZoom(target.id, { focal: { mode: "fixed", x: fx, y: fy } });
    st.select(target.id);
  };

  if (!project) {
    return <div className="stage stage--empty">No project open</div>;
  }

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="stage__canvas" onPointerDown={onPick} />
      {/* hidden media — src is relative to the .dolly bundle; absent on this host */}
      <video
        ref={videoRef}
        src={project.source.proxy}
        muted
        playsInline
        preload="auto"
        style={{ display: "none" }}
      />
      {project.audio.map((a) => (
        <audio
          key={a.role}
          ref={a.role === "system" ? sysAudioRef : micAudioRef}
          src={a.file}
          preload="auto"
          style={{ display: "none" }}
        />
      ))}
    </div>
  );
}

function resyncAudio(audio: HTMLAudioElement | null, video: HTMLVideoElement): void {
  if (!audio || audio.readyState < 1) return;
  if (Math.abs(audio.currentTime - video.currentTime) > SYNC_THRESHOLD) {
    audio.currentTime = video.currentTime;
  }
}

function sizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
