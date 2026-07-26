/// <reference types="vite/client" />

/**
 * `requestVideoFrameCallback` (BUILD_PLAN §6.2) is not in the default TS DOM lib yet.
 * Minimal ambient declaration so the playback loop in Stage.tsx type-checks.
 */
interface VideoFrameCallbackMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
  captureTime?: number;
  receiveTime?: number;
  rtpTimestamp?: number;
}

type VideoFrameRequestCallback = (
  now: DOMHighResTimeStamp,
  metadata: VideoFrameCallbackMetadata,
) => void;

interface HTMLVideoElement {
  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback(handle: number): void;
}
