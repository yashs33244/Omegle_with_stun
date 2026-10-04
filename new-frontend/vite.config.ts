import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { selfHostedModels } from "./vite.models";

// https://vitejs.dev/config/
export default defineConfig({
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
});
