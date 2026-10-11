import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { selfHostedModels } from "./vite.models";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  define: {
    // Public origin of the site (no trailing slash). Set VITE_SITE_URL at
    // build time; it fills the canonical, og:url and og:image URLs in
    // index.html and the prerendered route shells (scripts/prerender-meta.mjs),
    // and import.meta.env.VITE_SITE_URL in the bundle.
    "import.meta.env.VITE_SITE_URL": JSON.stringify(
      (loadEnv(mode, process.cwd(), "VITE_SITE_URL").VITE_SITE_URL || "https://chizzy.itsyash.space").replace(/\/+$/, ""),
    ),
  },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), selfHostedModels()],
  // The moderation workers are ES modules (MediaPipe loads its wasm with import()).
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
