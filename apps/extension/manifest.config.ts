import { defineManifest } from "@crxjs/vite-plugin";

/**
 * DOLLY authoring extension — MV3 manifest.
 *
 * - `tabCapture` + `offscreen`: record the active tab to a webm for "watch" mode.
 * - `scripting` + `<all_urls>` content script: install the DOM recorder in the page.
 * - `storage`: persist the in-progress Recording (the service worker is ephemeral).
 * - `downloads`: save the exported Recording JSON and the webm blob.
 */
export default defineManifest({
  manifest_version: 3,
  name: "DOLLY — walkthrough recorder",
  version: "0.1.0",
  description:
    "Record DOM-aware click-throughs of any web app. Export an interactive walkthrough that viewers can watch or replay live in their own browser.",
  permissions: ["activeTab", "scripting", "storage", "tabCapture", "downloads", "offscreen"],
  host_permissions: ["<all_urls>"],
  action: { default_popup: "src/popup/index.html", default_title: "DOLLY" },
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/recorder-content.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  web_accessible_resources: [
    {
      resources: ["src/content/*", "assets/*"],
      matches: ["<all_urls>"],
    },
  ],
});
