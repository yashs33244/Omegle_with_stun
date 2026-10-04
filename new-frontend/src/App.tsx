import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import { ErrorBoundary } from "./components/ErrorBoundary";
import NotFound from "./pages/NotFound";
import { Landing } from "./pages/Landing";

// The moderation console is its own chunk, never part of the main bundle.
const AdminPage = lazy(() => import("./pages/admin/AdminPage"));

const App = () => (
  <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route
          path="/admin/*"
          element={
            <Suspense fallback={<p className="p-4 text-sm">Loading...</p>}>
              <AdminPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </ErrorBoundary>
);

export default App;
