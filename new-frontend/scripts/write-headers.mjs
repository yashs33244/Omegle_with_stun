// Runs after `vite build` and prerender-meta.mjs (see package.json "build").
// Writes what Cloudflare Pages needs on top of the Vite output; nginx and
// Vercel ignore both additions.
//
// 1. dist/_headers, rendered from _headers.template: the response headers
//    Pages sends. The only substitution is ${CSP_CONNECT_SRC}: 'self' plus the
//    API origin over http(s) and ws(s), derived from VITE_API_URL exactly like
//    nginx-api-origin.envsh does for the nginx image, so the CSP allows the API
//    and socket origin the bundle was built for. VITE_API_URL comes from the
//    environment or Vite's .env files (loadEnv, the same lookup the bundle
//    uses); the fallback matches src/lib/config.ts.
//
// 2. dist/<route>.html next to each dist/<route>/index.html that
//    prerender-meta.mjs wrote. Pages answers /terms with a 308 to /terms/ when
//    only terms/index.html exists, but serves terms.html at /terms directly
//    (and /terms/ keeps working from the directory), so the canonical
//    extension-less URLs stay 200 like on nginx and Vercel.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

const apiUrl = loadEnv("production", root, "VITE_API_URL").VITE_API_URL || "https://chizzyapi.itsyash.space";
const { protocol, origin } = new URL(apiUrl);
if (protocol !== "https:" && protocol !== "http:") throw new Error(`VITE_API_URL ${apiUrl} is not an http(s) URL`);
const connectSrc = `'self' ${origin} ${origin.replace(/^http/, "ws")}`;

const template = readFileSync(join(root, "_headers.template"), "utf8").split("\n");
const placeholders = template.filter((line) => !line.startsWith("#") && line.includes("${CSP_CONNECT_SRC}"));
if (placeholders.length !== 1) throw new Error("_headers.template must use ${CSP_CONNECT_SRC} on exactly one header line");
const headers = template.map((line) => (line.startsWith("#") ? line : line.replace("${CSP_CONNECT_SRC}", connectSrc))).join("\n");

// Pages limits: 100 rules, 2000 characters per line.
const longest = Math.max(...headers.split("\n").map((line) => line.length));
if (longest > 2000) throw new Error(`_headers has a ${longest}-character line; Pages allows 2000`);
const rules = headers.split("\n").filter((line) => /^\S/.test(line) && !line.startsWith("#")).length;
if (rules > 100) throw new Error(`_headers has ${rules} rules; Pages allows 100`);
writeFileSync(join(dist, "_headers"), headers);

const routes = Object.keys(JSON.parse(readFileSync(join(root, "src/lib/seoRoutes.json"), "utf8"))).filter((path) => path !== "/");
for (const path of routes) copyFileSync(join(dist, path.slice(1), "index.html"), join(dist, `${path.slice(1)}.html`));

console.log(`write-headers: dist/_headers with ${rules} rules, connect-src ${connectSrc}; ${routes.length} extension-less route shells`);
