//! Supervision of the `dollyd` Swift sidecar (BUILD_PLAN §2.2, §3.4).
//!
//! The sidecar owns ScreenCaptureKit / AVAssetWriter / event monitoring. This module speaks
//! the newline-delimited JSON protocol to it over stdin/stdout:
//!
//!   * requests  — one JSON object per line written to the child's stdin,
//!   * responses — `{ "id": N, "ok": true, ... }` / `{ "id": N, "ok": false, "code", "msg" }`
//!                 routed back to the matching in-flight request,
//!   * events    — `{ "ev": "...", ... }` fanned out on a broadcast channel that `main.rs`
//!                 relays to the webview,
//!   * stderr    — a plain-text log, drained and never parsed (§3.4).
//!
//! A single supervisor task owns the child's lifecycle: it writes requests, reads responses,
//! and restarts the child on crash with a bounded backoff.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::{sleep, timeout};

/// Default deadline for control commands (listSources, ping, start, stop).
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Export renders the whole movie before replying; progress arrives as events meanwhile.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);
/// Broadcast backlog for sidecar events before slow subscribers start lagging.
const EVENT_CHANNEL_CAP: usize = 512;
const RESTART_BACKOFF_MIN: Duration = Duration::from_millis(250);
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------------------
// Protocol types — mirror packages/schema/schema/sidecar.schema.json (§3.4).
// ---------------------------------------------------------------------------------------

/// A capture target: a display, a window, or a region of a display.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CaptureTarget {
    Display { id: u64 },
    Window { id: u64 },
    Region { display: u64, rect: Rect },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Studio,
    Quick,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum ExportPreset {
    #[serde(rename = "h264-1080p")]
    H264_1080p,
    #[serde(rename = "h264-4k")]
    H264_4k,
    #[serde(rename = "hevc-4k")]
    Hevc4k,
    #[serde(rename = "gif-720p")]
    Gif720p,
}

/// A request to the sidecar. Serialized as `{ "cmd": "...", ... }`; the request `id` is
/// injected by [`Sidecar::request`] just before the line is written.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "cmd")]
pub enum SidecarRequest {
    #[serde(rename = "listSources")]
    ListSources,
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "start")]
    Start {
        target: CaptureTarget,
        quality: Quality,
        #[serde(skip_serializing_if = "Option::is_none")]
        mic: Option<String>,
        #[serde(rename = "systemAudio")]
        system_audio: bool,
        #[serde(rename = "detectTyping", skip_serializing_if = "Option::is_none")]
        detect_typing: Option<bool>,
        out: String,
    },
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "export")]
    Export {
        project: String,
        out: String,
        preset: ExportPreset,
    },
}

impl SidecarRequest {
    /// Control commands get the default deadline; export gets the long one.
    fn timeout(&self) -> Duration {
        match self {
            SidecarRequest::Export { .. } => EXPORT_TIMEOUT,
            _ => DEFAULT_TIMEOUT,
        }
    }
}

/// An unsolicited event from the sidecar (`{ "ev": "...", ... }`). Re-serialized verbatim
/// to the webview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "ev")]
pub enum SidecarEvent {
    #[serde(rename = "recording")]
    Recording { t: f64, dropped: u64 },
    #[serde(rename = "exportProgress")]
    ExportProgress { p: f64, fps: f64 },
    #[serde(rename = "error")]
    Error { code: String, msg: String },
}

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("sidecar is not running")]
    Unavailable,
    #[error("sidecar request timed out")]
    Timeout,
    #[error("sidecar returned malformed response")]
    Malformed,
    #[error("sidecar error [{code}]: {msg}")]
    Remote { code: String, msg: String },
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
}

type PendingMap = Arc<StdMutex<HashMap<u64, oneshot::Sender<Value>>>>;

// ---------------------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------------------

/// Cheap-to-clone handle to the sidecar supervisor. Cloning shares the same child process,
/// pending-request table, and event broadcast.
#[derive(Clone)]
pub struct Sidecar {
    cmd_tx: mpsc::UnboundedSender<String>,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
    events_tx: broadcast::Sender<SidecarEvent>,
    started: Arc<AtomicBool>,
    // Held until start() hands it to the supervisor task exactly once.
    cmd_rx: Arc<StdMutex<Option<mpsc::UnboundedReceiver<String>>>>,
}

impl Sidecar {
    pub fn new() -> Self {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<String>();
        let (events_tx, _) = broadcast::channel::<SidecarEvent>(EVENT_CHANNEL_CAP);
        Self {
            cmd_tx,
            pending: Arc::new(StdMutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            events_tx,
            started: Arc::new(AtomicBool::new(false)),
            cmd_rx: Arc::new(StdMutex::new(Some(cmd_rx))),
        }
    }

    /// Subscribe to the sidecar event stream. `main.rs` relays these to the webview.
    pub fn subscribe(&self) -> broadcast::Receiver<SidecarEvent> {
        self.events_tx.subscribe()
    }

    /// Launch the supervisor task for the sidecar at `binary`. Idempotent — the second call
    /// is a no-op. Runs on Tauri's async runtime (tokio).
    pub fn start(&self, binary: PathBuf) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let cmd_rx = match self.cmd_rx.lock().unwrap().take() {
            Some(rx) => rx,
            None => return,
        };
        let pending = self.pending.clone();
        let events_tx = self.events_tx.clone();
        tauri::async_runtime::spawn(async move {
            supervise(binary, cmd_rx, pending, events_tx).await;
        });
    }

    /// Send a request and await its response. Returns the full response object on `ok:true`,
    /// or [`SidecarError::Remote`] on `ok:false`.
    pub async fn request(&self, req: SidecarRequest) -> Result<Value, SidecarError> {
        let deadline = req.timeout();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        let mut value = serde_json::to_value(&req)?;
        match value {
            Value::Object(ref mut map) => {
                map.insert("id".to_string(), Value::from(id));
            }
            _ => return Err(SidecarError::Malformed),
        }
        let line = serde_json::to_string(&value)?;

        let (tx, rx) = oneshot::channel::<Value>();
        self.pending.lock().unwrap().insert(id, tx);

        if self.cmd_tx.send(line).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(SidecarError::Unavailable);
        }

        match timeout(deadline, rx).await {
            Ok(Ok(resp)) => interpret_response(resp),
            // Sender dropped: the child crashed and pending requests were flushed.
            Ok(Err(_)) => Err(SidecarError::Unavailable),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(SidecarError::Timeout)
            }
        }
    }
}

impl Default for Sidecar {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri-managed wrapper so the handle can live in application state.
pub struct SidecarState {
    pub sidecar: Sidecar,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            sidecar: Sidecar::new(),
        }
    }
}

impl Default for SidecarState {
    fn default() -> Self {
        Self::new()
    }
}

fn interpret_response(resp: Value) -> Result<Value, SidecarError> {
    match resp.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(resp),
        Some(false) => {
            let code = resp
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let msg = resp
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Err(SidecarError::Remote { code, msg })
        }
        None => Err(SidecarError::Malformed),
    }
}

// ---------------------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------------------

async fn supervise(
    binary: PathBuf,
    mut cmd_rx: mpsc::UnboundedReceiver<String>,
    pending: PendingMap,
    events_tx: broadcast::Sender<SidecarEvent>,
) {
    let mut backoff = RESTART_BACKOFF_MIN;

    loop {
        // TODO(mac): in `tauri dev` the externalBin is copied next to the dev binary with a
        // target-triple suffix (dollyd-aarch64-apple-darwin); resolve_sidecar_path in main.rs
        // targets the bundled `Contents/MacOS/dollyd` layout used in release.
        let mut child = match Command::new(&binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                eprintln!(
                    "[dollyd] failed to spawn sidecar at {}: {err}",
                    binary.display()
                );
                sleep(backoff).await;
                backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
                continue;
            }
        };
        backoff = RESTART_BACKOFF_MIN;

        let mut stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                eprintln!("[dollyd] child has no stdin; retrying");
                let _ = child.kill().await;
                sleep(backoff).await;
                continue;
            }
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let reader = stdout.map(|out| {
            let pending = pending.clone();
            let events_tx = events_tx.clone();
            tauri::async_runtime::spawn(read_stdout(out, pending, events_tx))
        });
        let drain = stderr.map(|err| tauri::async_runtime::spawn(drain_stderr(err)));

        // Inner loop: pump requests to stdin until the child dies or the API is dropped.
        let shutdown = loop {
            tokio::select! {
                maybe_line = cmd_rx.recv() => match maybe_line {
                    Some(line) => {
                        if let Err(err) = write_line(&mut stdin, &line).await {
                            eprintln!("[dollyd] write to sidecar stdin failed: {err}");
                            break false; // stdin broken -> respawn
                        }
                    }
                    None => break true, // all Sidecar handles dropped -> shut down
                },
                status = child.wait() => {
                    match status {
                        Ok(code) => eprintln!("[dollyd] sidecar exited: {code}"),
                        Err(err) => eprintln!("[dollyd] waiting on sidecar failed: {err}"),
                    }
                    break false; // crashed -> respawn
                }
            }
        };

        if let Some(reader) = reader {
            reader.abort();
        }
        if let Some(drain) = drain {
            drain.abort();
        }

        if shutdown {
            let _ = child.kill().await;
            return;
        }

        // Fail every in-flight request so callers don't hang until their timeout.
        fail_all_pending(&pending);
        let _ = child.kill().await;
        sleep(backoff).await;
        backoff = (backoff * 2).min(RESTART_BACKOFF_MAX);
    }
}

async fn write_line(stdin: &mut tokio::process::ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

/// Read stdout line by line, routing responses to pending requests and events to the broadcast.
async fn read_stdout(
    stdout: tokio::process::ChildStdout,
    pending: PendingMap,
    events_tx: broadcast::Sender<SidecarEvent>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break, // EOF: child closed stdout
            Err(err) => {
                eprintln!("[dollyd] stdout read error: {err}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("[dollyd] unparseable stdout line ({err}): {trimmed}");
                continue;
            }
        };

        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            // Response to an in-flight request.
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(value);
            } else {
                eprintln!("[dollyd] response for unknown request id {id}");
            }
        } else if value.get("ev").is_some() {
            match serde_json::from_value::<SidecarEvent>(value) {
                Ok(event) => {
                    // Err only when there are no subscribers; harmless.
                    let _ = events_tx.send(event);
                }
                Err(err) => eprintln!("[dollyd] unrecognized event: {err}"),
            }
        } else {
            eprintln!("[dollyd] stdout line with neither id nor ev: {trimmed}");
        }
    }
}

/// Drain stderr into the app log. Per §3.4 it is never parsed as protocol.
async fn drain_stderr(stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    // TODO(mac): route to the app's rotating log file instead of the parent's stderr.
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[dollyd:stderr] {line}");
    }
}

fn fail_all_pending(pending: &PendingMap) {
    // Dropping each oneshot::Sender wakes its receiver with a RecvError, which request()
    // maps to SidecarError::Unavailable.
    pending.lock().unwrap().clear();
}
