import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import routes from "./seoRoutes.json";

/** Title and description per indexable route; scripts/prerender-meta.mjs bakes the same table into dist/. */
const ROUTES: Record<string, { title: string; description: string }> = routes;

/**
 * Keeps <title>, the description and the canonical link in step with
 * client-side navigation. Crawlers get the same values from the prerendered
 * shells, so a page looks identical whether it was loaded directly or reached
 * from the landing page.
 */
export function RouteMeta(): null {
  const { pathname } = useLocation();
  useEffect(() => {
    const path = pathname.replace(/\/+$/, "") || "/";
    const meta = ROUTES[path];
    document.title = (meta ?? ROUTES["/"]).title;
    if (!meta) return;
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", meta.description);
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = `${import.meta.env.VITE_SITE_URL || window.location.origin}${path}`;
  }, [pathname]);
  return null;
}
