// Runs after `vite build` (see package.json "build").
//
// Crawlers and link previews only read the static HTML, so every indexable
// route gets its own copy of the SPA shell with the route's title,
// description, canonical and og/twitter copies substituted:
// dist/index.html for "/" and dist/<route>/index.html for the rest (nginx
// try_files picks `$uri/` up before the shell fallback). The same table drives
// RouteMeta (src/lib/seo.ts) at runtime. Also writes sitemap.xml and
// robots.txt, which need the absolute origin that vite.config.ts baked into
// the canonical link.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const routes = JSON.parse(readFileSync(join(root, "src/lib/seoRoutes.json"), "utf8"));
const shell = readFileSync(join(dist, "index.html"), "utf8");

const canonical = shell.match(/<link rel="canonical" href="([^"]+)\/" \/>/);
if (!canonical) throw new Error("dist/index.html has no canonical link; index.html changed shape");
const origin = canonical[1];
if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error(`canonical origin ${origin} is not an absolute origin`);

const escapeAttr = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Replaces exactly one occurrence; a missing or duplicated tag means index.html changed shape. */
function replaceOnce(html, pattern, replacement) {
  const matches = html.match(new RegExp(pattern.source, "g"));
  if (!matches || matches.length !== 1) {
    throw new Error(`expected exactly one match for ${pattern} in dist/index.html, found ${matches ? matches.length : 0}`);
  }
  return html.replace(pattern, replacement);
}

function render(path, { title, description }) {
  const url = `${origin}${path}`;
  let html = shell;
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${escapeAttr(title)}</title>`);
  html = replaceOnce(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`);
  html = replaceOnce(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`);
  for (const [attr, name, value] of [
    ["name", "description", description],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
  ]) {
    html = replaceOnce(
      html,
      new RegExp(`<meta ${attr}="${name}" content="[^"]*" />`),
      `<meta ${attr}="${name}" content="${escapeAttr(value)}" />`,
    );
  }
  return html;
}

const paths = Object.keys(routes);
for (const path of paths) {
  if (path !== "/" && !/^\/[a-z0-9-]+$/.test(path)) throw new Error(`unsupported route ${path}: one segment, no trailing slash`);
  const file = path === "/" ? join(dist, "index.html") : join(dist, path.slice(1), "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, render(path, routes[path]));
}

const urls = paths.map((path) => `  <url>\n    <loc>${origin}${path}</loc>\n  </url>`).join("\n");
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
);
writeFileSync(
  join(dist, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /room\nDisallow: /api\n\nSitemap: ${origin}/sitemap.xml\n`,
);

console.log(`prerender-meta: ${paths.length} routes, sitemap.xml and robots.txt for ${origin}`);
