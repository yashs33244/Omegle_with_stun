import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * `vite preview` config for the e2e servers: serves the build with the same
 * security headers nginx adds in production (nginx-security-headers.conf),
 * the CSP connect-src derived from VITE_API_URL the way nginx-api-origin.envsh
 * does it. So the e2e run fails if the CSP blocks anything the app needs.
 */
function productionSecurityHeaders(apiUrl: string): Record<string, string> {
  const conf = readFileSync(new URL("../nginx-security-headers.conf", import.meta.url), "utf8");
  const origin = new URL(apiUrl).origin;
  const connectSrc = `'self' ${origin} ${origin.replace(/^http/, "ws")}`;
  const headers: Record<string, string> = {};
  for (const m of conf.matchAll(/^\s*add_header\s+(\S+)\s+"([^"]*)"\s+always;/gm)) {
    headers[m[1].toLowerCase()] = m[2].replace("${CSP_CONNECT_SRC}", connectSrc);
  }
  if (!headers["content-security-policy"]) throw new Error("No CSP found in nginx-security-headers.conf");
  return headers;
}

const apiUrl = process.env.VITE_API_URL;
if (!apiUrl) throw new Error("VITE_API_URL must be set for the e2e preview server");

export default defineConfig({
  preview: { headers: productionSecurityHeaders(apiUrl) },
});
