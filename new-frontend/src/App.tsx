import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import { ErrorBoundary } from "./components/ErrorBoundary";
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

const App = () => (
  <ErrorBoundary>
    <BrowserRouter>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route
            path="/"
            element={
              <Gate>
                <Landing />
              </Gate>
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
