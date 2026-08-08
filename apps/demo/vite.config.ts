import { defineConfig } from "vite";

// Static demo page. Bundles the player SDK and a sample Recording into a single loadable page.
export default defineConfig({
  build: { target: "es2022", outDir: "dist" },
});
