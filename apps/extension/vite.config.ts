import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.js";

// Builds a loadable MV3 extension into dist/. @crxjs bundles the service worker and content
// script (as an isolated-world module) and rewrites the manifest to point at the emitted files.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2022",
    rollupOptions: {
      // Keep chunk names stable so web_accessible_resources globs match.
      output: { chunkFileNames: "assets/[name]-[hash].js" },
    },
  },
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
});
