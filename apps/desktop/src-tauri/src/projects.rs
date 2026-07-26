//! Reading and writing the `.dolly` project bundle (BUILD_PLAN §3.1, §3.3).
//!
//! A `.dolly` bundle is a directory (an opaque package in Finder) containing `project.json`
//! plus the media files. The Rust shell only needs to load and save `project.json` faithfully
//! and keep a recent-projects list in the app config dir; media is produced/consumed by the
//! sidecar. The [`Project`] struct mirrors packages/schema/schema/project.schema.json.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const PROJECT_FILE: &str = "project.json";
const RECENTS_FILE: &str = "recent-projects.json";
const MAX_RECENTS: usize = 12;

// ---------------------------------------------------------------------------------------
// project.json (§3.3)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub version: u32,
    pub source: Source,
    pub audio: Vec<AudioTrack>,
    pub trim: Trim,
    pub composition: Composition,
    pub cursor: CursorStyle,
    pub zooms: Vec<Zoom>,
    pub speed: Vec<SpeedSegment>,
    #[serde(rename = "autoZoom", default, skip_serializing_if = "Option::is_none")]
    pub auto_zoom: Option<AutoZoomMeta>,
    /// Forward-compat: round-trip any keys added by newer writers without dropping them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub master: String,
    pub proxy: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTrack {
    pub file: String,
    pub role: AudioRole,
    pub gain: f64,
    pub muted: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioRole {
    System,
    Mic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Trim {
    #[serde(rename = "in")]
    pub in_: f64,
    pub out: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Composition {
    pub backdrop: Backdrop,
    pub padding: f64,
    pub radius: f64,
    pub shadow: Shadow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Backdrop {
    Gradient { from: String, to: String, angle: f64 },
    Solid { color: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Shadow {
    pub enabled: bool,
    pub opacity: f64,
    pub blur: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CursorStyle {
    pub visible: bool,
    pub size: f64,
    pub smoothing: f64,
    #[serde(rename = "clickRipple")]
    pub click_ripple: bool,
    #[serde(rename = "hideWhenIdle")]
    pub hide_when_idle: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Zoom {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub scale: f64,
    pub focal: Focal,
    #[serde(rename = "rampIn")]
    pub ramp_in: f64,
    #[serde(rename = "rampOut")]
    pub ramp_out: f64,
    pub easing: Easing,
    pub origin: ZoomOrigin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Focal {
    Fixed { x: f64, y: f64 },
    Follow { damping: f64, track: FocalTrack },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FocalTrack {
    Cursor,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum Easing {
    #[serde(rename = "cubicInOut")]
    CubicInOut,
    #[serde(rename = "cubicOut")]
    CubicOut,
    #[serde(rename = "linear")]
    Linear,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ZoomOrigin {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SpeedSegment {
    pub start: f64,
    pub end: f64,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoZoomMeta {
    #[serde(rename = "lastRunParams")]
    pub last_run_params: Value,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

// ---------------------------------------------------------------------------------------
// Bundle I/O
// ---------------------------------------------------------------------------------------

/// Load `project.json` from a `.dolly` bundle directory.
pub fn load(bundle: &Path) -> anyhow::Result<Project> {
    let manifest = bundle.join(PROJECT_FILE);
    let bytes = fs::read(&manifest)
        .with_context(|| format!("reading {}", manifest.display()))?;
    let project: Project = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing {}", manifest.display()))?;
    Ok(project)
}

/// Write `project.json` into a `.dolly` bundle directory, creating it if needed.
/// Written to a temp file then renamed so a crash mid-write can't corrupt the manifest.
pub fn save(bundle: &Path, project: &Project) -> anyhow::Result<()> {
    fs::create_dir_all(bundle)
        .with_context(|| format!("creating bundle {}", bundle.display()))?;
    let manifest = bundle.join(PROJECT_FILE);
    let tmp = bundle.join(".project.json.tmp");
    let json = serde_json::to_vec_pretty(project).context("serializing project.json")?;
    fs::write(&tmp, &json).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, &manifest)
        .with_context(|| format!("committing {}", manifest.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Recent projects (persisted to the app config dir)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: PathBuf,
    pub name: String,
    /// Unix seconds; kept dependency-free (no chrono in the shell).
    #[serde(rename = "openedAt")]
    pub opened_at: u64,
}

fn recents_path(config_dir: &Path) -> PathBuf {
    config_dir.join(RECENTS_FILE)
}

/// Load the recent-projects list. Missing/corrupt file yields an empty list rather than an error.
pub fn load_recents(config_dir: &Path) -> Vec<RecentEntry> {
    match fs::read(recents_path(config_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Record `bundle` as most-recently-opened and persist the (deduplicated, capped) list.
pub fn push_recent(config_dir: &Path, bundle: &Path) -> anyhow::Result<Vec<RecentEntry>> {
    let path = bundle.canonicalize().unwrap_or_else(|_| bundle.to_path_buf());
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".to_string());
    let opened_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut list = load_recents(config_dir);
    list.retain(|e| e.path != path);
    list.insert(0, RecentEntry { path, name, opened_at });
    list.truncate(MAX_RECENTS);

    fs::create_dir_all(config_dir)
        .with_context(|| format!("creating config dir {}", config_dir.display()))?;
    let bytes = serde_json::to_vec_pretty(&list).context("serializing recents")?;
    fs::write(recents_path(config_dir), &bytes).context("writing recents")?;
    Ok(list)
}
