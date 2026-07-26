// DOLLY — Tauri v2 desktop shell (BUILD_PLAN §2.1, §4).
// Hide the extra console window on Windows in release. DOLLY targets macOS, but this is the
// canonical Tauri header and costs nothing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod projects;
mod sidecar;

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast::error::RecvError;

use sidecar::{
    CaptureTarget, ExportPreset, Quality, Sidecar, SidecarError, SidecarRequest, SidecarState,
};

/// Event name the webview listens on for the sidecar telemetry/progress stream.
const SIDECAR_EVENT: &str = "sidecar://event";

// ---------------------------------------------------------------------------------------
// Command argument shapes (deserialized from the webview's invoke() payload)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct StartArgs {
    pub target: CaptureTarget,
    pub quality: Quality,
    #[serde(default)]
    pub mic: Option<String>,
    #[serde(rename = "systemAudio")]
    pub system_audio: bool,
    #[serde(rename = "detectTyping", default)]
    pub detect_typing: Option<bool>,
    pub out: String,
}

#[derive(Debug, Deserialize)]
pub struct ExportArgs {
    pub project: String,
    pub out: String,
    pub preset: ExportPreset,
}

// ---------------------------------------------------------------------------------------
// Sidecar commands — thin forwarders to the supervisor
// ---------------------------------------------------------------------------------------

#[tauri::command]
async fn list_sources(state: State<'_, SidecarState>) -> Result<Value, String> {
    let sidecar = state.sidecar.clone();
    sidecar
        .request(SidecarRequest::ListSources)
        .await
        .map_err(err_to_string)
}

#[tauri::command]
async fn ping(state: State<'_, SidecarState>) -> Result<Value, String> {
    let sidecar = state.sidecar.clone();
    sidecar.request(SidecarRequest::Ping).await.map_err(err_to_string)
}

#[tauri::command]
async fn start_recording(state: State<'_, SidecarState>, args: StartArgs) -> Result<Value, String> {
    let sidecar = state.sidecar.clone();
    let req = SidecarRequest::Start {
        target: args.target,
        quality: args.quality,
        mic: args.mic,
        system_audio: args.system_audio,
        detect_typing: args.detect_typing,
        out: args.out,
    };
    sidecar.request(req).await.map_err(err_to_string)
}

#[tauri::command]
async fn stop_recording(state: State<'_, SidecarState>) -> Result<Value, String> {
    let sidecar = state.sidecar.clone();
    sidecar.request(SidecarRequest::Stop).await.map_err(err_to_string)
}

#[tauri::command]
async fn export(state: State<'_, SidecarState>, args: ExportArgs) -> Result<Value, String> {
    let sidecar = state.sidecar.clone();
    let req = SidecarRequest::Export {
        project: args.project,
        out: args.out,
        preset: args.preset,
    };
    sidecar.request(req).await.map_err(err_to_string)
}

// ---------------------------------------------------------------------------------------
// Project commands — read/write the .dolly bundle
// ---------------------------------------------------------------------------------------

#[tauri::command]
async fn open_project(app: AppHandle, path: String) -> Result<projects::Project, String> {
    let bundle = PathBuf::from(&path);
    let project = projects::load(&bundle).map_err(|e| format!("{e:#}"))?;
    if let Some(dir) = config_dir(&app) {
        // Best-effort: failing to update the recents list must not fail the open.
        if let Err(e) = projects::push_recent(&dir, &bundle) {
            eprintln!("[projects] could not update recents: {e:#}");
        }
    }
    Ok(project)
}

#[tauri::command]
async fn save_project(path: String, project: projects::Project) -> Result<(), String> {
    projects::save(&PathBuf::from(path), &project).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn recent_projects(app: AppHandle) -> Result<Vec<projects::RecentEntry>, String> {
    let dir = config_dir(&app).ok_or_else(|| "no app config directory".to_string())?;
    Ok(projects::load_recents(&dir))
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

fn err_to_string(err: SidecarError) -> String {
    err.to_string()
}

fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// Resolve the path to the bundled `dollyd` sidecar.
///
/// In a shipped `.app`, Tauri places the externalBin next to the main binary in
/// `DOLLY.app/Contents/MacOS/`, so it sits beside `current_exe()`.
fn resolve_sidecar_path(_app: &AppHandle) -> PathBuf {
    // TODO(mac): under `tauri dev` the binary is `dollyd-<target-triple>`; a dev build should
    // fall back to that name (and to a repo-relative debug path) when the sibling is absent.
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("dollyd")))
        .unwrap_or_else(|| PathBuf::from("dollyd"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState::new())
        .setup(|app| {
            let handle = app.handle().clone();

            // Boot the sidecar supervisor and start relaying its events to the webview.
            let sidecar: Sidecar = app.state::<SidecarState>().sidecar.clone();
            sidecar.start(resolve_sidecar_path(&handle));

            let mut events = sidecar.subscribe();
            let emit_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            if let Err(e) = emit_handle.emit(SIDECAR_EVENT, event) {
                                eprintln!("[sidecar] failed to emit event to webview: {e}");
                            }
                        }
                        // A slow webview dropped some events; keep going.
                        Err(RecvError::Lagged(n)) => {
                            eprintln!("[sidecar] webview lagged, dropped {n} events");
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sources,
            ping,
            start_recording,
            stop_recording,
            export,
            open_project,
            save_project,
            recent_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DOLLY");
}
