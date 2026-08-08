/**
 * Offscreen document: hosts the MediaRecorder for tab video capture. A service worker has no DOM
 * and cannot own a MediaStream/MediaRecorder, so the worker asks this document to record and hands
 * back a blob object URL when it stops.
 */
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

async function start(streamId: string): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // chromeMediaSource is a non-standard tabCapture constraint
    video: {
      // @ts-expect-error non-standard mandatory constraints for tab capture
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    audio: false,
  });
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ type: "OFFSCREEN_BLOB", url });
  };
  recorder.start();
}

function stop(): void {
  recorder?.stop();
  recorder = null;
}

chrome.runtime.onMessage.addListener((msg: { type: string; streamId?: string }) => {
  if (msg.type === "OFFSCREEN_START" && msg.streamId) void start(msg.streamId).catch(() => void 0);
  else if (msg.type === "OFFSCREEN_STOP") stop();
});
