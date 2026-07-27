//! Optional AI "director" for the AI-optimized cursor (BUILD_PLAN Cursorcraft §4).
//!
//! This lives in the Rust shell — NOT the webview — so the user's Claude API key never enters
//! the WKWebView JS context. Given a privacy-preserving interaction summary (normalized cursor
//! coordinates + timing + click flags only — no screen content, no keystroke content), it asks
//! Claude to plan an idealized "beat sequence" the pure optimizer then follows.
//!
//! It is strictly opt-in: `director_available` reports whether a key is configured, and every
//! failure path returns an error the frontend treats as "fall back to the local optimizer".
//!
//! There is no official Anthropic Rust SDK, so this calls the Messages API over raw HTTPS
//! (the documented path for unsupported languages).

use serde::{Deserialize, Serialize};

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Default model for the director. A lightweight structured-planning task; kept configurable.
const DIRECTOR_MODEL: &str = "claude-opus-5";
const KEYCHAIN_SERVICE: &str = "app.dolly.desktop";
const KEYCHAIN_ACCOUNT: &str = "anthropic_api_key";

/// One recorded target in the interaction summary sent up from the frontend.
#[derive(Debug, Deserialize)]
pub struct TargetSummary {
    pub t: f64,
    pub x: f64,
    pub y: f64,
    pub click: bool,
    pub score: f64,
}

#[derive(Debug, Deserialize)]
pub struct DirectorSummary {
    pub targets: Vec<TargetSummary>,
    pub duration: f64,
}

/// A single planned beat — mirrors the TS `Beat` in @dolly/cursoropt (camelCase `adCopy`).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dwell: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ad_copy: Option<String>,
}

/// The plan returned to the frontend — mirrors the TS `BeatPlan`.
#[derive(Debug, Serialize, Deserialize)]
pub struct BeatPlan {
    pub beats: Vec<Beat>,
    pub source: String,
}

/// Locate the user's Claude API key.
///
/// TODO(mac): the primary source is the OS keychain (Keychain Services); `ANTHROPIC_API_KEY`
/// is a developer fallback. Storing/reading via the `keyring` crate is validated on device.
fn api_key() -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        if let Ok(secret) = entry.get_password() {
            if !secret.is_empty() {
                return Some(secret);
            }
        }
    }
    std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.is_empty())
}

/// JSON Schema the model's output is constrained to (structured outputs). Matches `BeatPlan`.
fn beat_plan_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["beats"],
        "properties": {
            "beats": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["x", "y"],
                    "properties": {
                        "x": { "type": "number" },
                        "y": { "type": "number" },
                        "dwell": { "type": "number" },
                        "click": { "type": "boolean" },
                        "t": { "type": "number" },
                        "adCopy": { "type": "string" }
                    }
                }
            }
        }
    })
}

const SYSTEM_PROMPT: &str = "\
You are a motion director for software product-demo videos. You receive an ordered list of \
interaction targets from a screen recording — each with a normalized position (x,y in [0,1], \
origin top-left), a timestamp in seconds, a click flag, and an interest score. You never see \
the screen contents or any typed text; work only from these coordinates and timings.

Plan a clean, purposeful cursor performance for an ad: an ordered sequence of beats the cursor \
should visit. Keep the meaningful targets (especially clicks), drop incidental wandering, and \
order them so the demo reads clearly. For each beat give x, y, an optional dwell (seconds to \
pause), whether it is a click, and an optional timestamp t (seconds) to hold sync with the \
video. You may also add a short one-line `adCopy` caption suggestion per beat. Respond ONLY \
with the structured object.";

/// Whether the director can run (a key is configured).
#[tauri::command]
pub async fn director_available() -> bool {
    api_key().is_some()
}

/// Ask Claude to plan a beat sequence from the interaction summary.
#[tauri::command]
pub async fn optimize_director(summary: DirectorSummary) -> Result<BeatPlan, String> {
    let key = api_key().ok_or_else(|| "no Claude API key configured".to_string())?;

    let user_content = serde_json::to_string(&serde_json::json!({
        "duration": summary.duration,
        "targets": summary.targets.iter().map(|t| serde_json::json!({
            "t": t.t, "x": t.x, "y": t.y, "click": t.click, "score": t.score
        })).collect::<Vec<_>>(),
    }))
    .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "model": DIRECTOR_MODEL,
        "max_tokens": 4096,
        "thinking": { "type": "adaptive" },
        "output_config": {
            "format": { "type": "json_schema", "schema": beat_plan_schema() }
        },
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user_content }],
    });

    // TODO(mac): verify TLS + proxy behavior on device; consider a timeout tuned for adaptive
    // thinking (the request can run several seconds).
    let client = reqwest::Client::new();
    let resp = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("director request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("director HTTP {status}: {text}"));
    }

    let payload: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    // A structured-outputs response carries the JSON object as text in the first content block.
    let text = payload
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|blocks| blocks.iter().find_map(|b| b.get("text").and_then(|t| t.as_str())))
        .ok_or_else(|| "director response had no text content".to_string())?;

    let mut plan: BeatPlan =
        serde_json::from_str(text).map_err(|e| format!("could not parse beat plan: {e}"))?;
    plan.source = "llm".to_string();
    Ok(plan)
}
