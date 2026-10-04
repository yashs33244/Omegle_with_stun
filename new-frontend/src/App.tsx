import { BrowserRouter, Routes, Route } from "react-router-dom";

import { ErrorBoundary } from "./components/ErrorBoundary";
import NotFound from "./pages/NotFound";
import { Landing } from "./pages/Landing";

const App = () => (
  <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </ErrorBoundary>
);

export default App;
