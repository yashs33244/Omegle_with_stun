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
  // nginx double-quoted strings may contain \" (Permissions-Policy allowlists quote origins).
  for (const m of conf.matchAll(/^\s*add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always;/gm)) {
    headers[m[1].toLowerCase()] = m[2].replace(/\\(.)/g, "$1").replace("${CSP_CONNECT_SRC}", connectSrc);
  }
  if (!headers["content-security-policy"]) throw new Error("No CSP found in nginx-security-headers.conf");
  headers["content-security-policy"] = allowTurnstile(headers["content-security-policy"]);
  return headers;
}

/**
 * The gate loads Cloudflare Turnstile. Until the production CSP (infra lane)
 * allows it, add its origin here so the e2e run can exercise the gate; a no-op
 * once nginx-security-headers.conf lists it.
 */
function allowTurnstile(csp: string): string {
  const origin = "https://challenges.cloudflare.com";
  const directives = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const hasFrameSrc = directives.some((d) => d.startsWith("frame-src "));
  const patched = directives.map((d) => {
    const sources = new Set(d.split(/\s+/));
    return (d.startsWith("script-src ") || d.startsWith("frame-src ")) && !sources.has(origin) ? `${d} ${origin}` : d;
  });
  if (!hasFrameSrc) patched.push(`frame-src ${origin}`);
  return patched.join("; ");
}

const apiUrl = process.env.VITE_API_URL;
if (!apiUrl) throw new Error("VITE_API_URL must be set for the e2e preview server");

export default defineConfig({
  preview: { headers: productionSecurityHeaders(apiUrl) },
});
