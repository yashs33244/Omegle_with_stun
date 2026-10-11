import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import { ErrorBoundary } from "./components/ErrorBoundary";
import { InAppBrowserNotice } from "./components/room/InAppBrowserNotice";
import { detectInAppBrowser } from "./lib/mobile";
import { RouteMeta } from "./lib/seo";
import NotFound from "./pages/NotFound";
import { Landing } from "./pages/Landing";
import { Gate } from "./pages/gate/Gate";

const Terms = lazy(() => import("./pages/legal/Terms"));
const Privacy = lazy(() => import("./pages/legal/Privacy"));
const Guidelines = lazy(() => import("./pages/legal/Guidelines"));
const Safety = lazy(() => import("./pages/legal/Safety"));
const Grievance = lazy(() => import("./pages/legal/Grievance"));
const LawEnforcement = lazy(() => import("./pages/legal/LawEnforcement"));
const Takedown = lazy(() => import("./pages/legal/Takedown"));

const PageFallback = () => <div className="min-h-screen bg-gray-100" aria-busy="true" />;

const AdminFallback = () => {
  const { t } = useTranslation();
  return <p className="p-4 text-sm">{t("loading")}</p>;
};

// The moderation console is its own chunk, never part of the main bundle.
const AdminPage = lazy(() => import("./pages/admin/AdminPage"));

/** In-app browsers (Instagram, WhatsApp...) get the "open in your browser" notice before the gate. */
const Home = () => {
  const [inAppApp, setInAppApp] = useState(() =>
    typeof navigator === "undefined" ? null : detectInAppBrowser(navigator.userAgent),
  );
  if (inAppApp) return <InAppBrowserNotice app={inAppApp} onContinue={() => setInAppApp(null)} />;
  return (
    <Gate>
      <Landing />
    </Gate>
  );
};

const App = () => (
  <ErrorBoundary>
    <BrowserRouter>
      <RouteMeta />
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/admin/*"
            element={
              <Suspense fallback={<AdminFallback />}>
                <AdminPage />
              </Suspense>
            }
          />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/guidelines" element={<Guidelines />} />
          <Route path="/safety" element={<Safety />} />
          <Route path="/grievance" element={<Grievance />} />
          <Route path="/law-enforcement" element={<LawEnforcement />} />
          <Route path="/takedown" element={<Takedown />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </ErrorBoundary>
);

export default App;
