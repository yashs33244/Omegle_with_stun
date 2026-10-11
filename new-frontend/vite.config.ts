import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { visualizer } from "rollup-plugin-visualizer";
import { selfHostedModels } from "./vite.models";

/**
 * Long-lived vendor chunks, so an app release does not invalidate the cached
 * framework code and the start screen's modulepreloads fetch in parallel.
 * Everything else stays with the code that imports it (Room, admin, legal
 * pages are dynamic imports and get their own chunks).
 */
const VENDOR_CHUNKS: Record<string, string> = {
  react: "vendor-react",
  "react-dom": "vendor-react",
  scheduler: "vendor-react",
  "use-sync-external-store": "vendor-react",
  "react-router": "vendor-react",
  "react-router-dom": "vendor-react",
  "@remix-run/router": "vendor-react",
  i18next: "vendor-i18n",
  "react-i18next": "vendor-i18n",
  "i18next-browser-languagedetector": "vendor-i18n",
  zod: "vendor-zod",
  "socket.io-client": "vendor-socket",
  "socket.io-parser": "vendor-socket",
  "engine.io-client": "vendor-socket",
  "engine.io-parser": "vendor-socket",
  "posthog-js": "vendor-posthog",
};

function vendorChunk(id: string): string | undefined {
  // The CommonJS interop helpers (a virtual module) must sit with the first
  // chunk that evaluates, react, or the vendor chunks import each other in a cycle.
  if (id.includes("commonjsHelpers")) return "vendor-react";
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id)?.[1];
  if (!pkg) return undefined;
  if (pkg.startsWith("@sentry/")) return "vendor-sentry";
  if (pkg.startsWith("@radix-ui/")) return "vendor-radix";
  return VENDOR_CHUNKS[pkg];
}

/**
 * Backend origin the way src/lib/config.ts resolves it: VITE_API_URL, else a
 * local backend for dev builds and the public API otherwise.
 */
function apiOrigin(mode: string): string {
  const url =
    loadEnv(mode, process.cwd(), "VITE_API_URL").VITE_API_URL ||
    (mode === "production" ? "https://chizzyapi.itsyash.space" : "http://localhost:3004");
  return new URL(url).origin;
}

/** `<link rel="preconnect">` to the API, so the first /api/config call skips DNS + TCP + TLS. */
function preconnectApi(mode: string): Plugin {
  return {
    name: "chizzy-preconnect-api",
    transformIndexHtml: () => [
      // The app fetches with credentials "omit", which shares an anonymous (crossorigin) connection.
      { tag: "link", attrs: { rel: "preconnect", href: apiOrigin(mode), crossorigin: "" }, injectTo: "head-prepend" },
    ],
  };
}

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
  plugins: [
    react(),
    selfHostedModels(),
    preconnectApi(mode),
    // `npm run analyze` writes dist/stats.html with every chunk's contents.
    process.env.ANALYZE ? visualizer({ filename: "dist/stats.html", gzipSize: true, template: "treemap" }) : null,
  ],
  build: {
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
  // The moderation workers are ES modules (MediaPipe loads its wasm with import()).
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
