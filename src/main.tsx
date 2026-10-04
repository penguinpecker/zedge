import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import { appMode } from "./chain/mode";
import type { LegalPageId } from "./pages/LegalPage";
import "./styles.css";

const mode = appMode(window.location.search, window.location.hash);
const legalRoutes: Record<string, LegalPageId> = {
  "/terms": "terms",
  "/privacy": "privacy",
  "/risk-disclosure": "risk-disclosure",
  "/market-rules": "market-rules",
  "/support": "support",
};
const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
const legalPage = Object.hasOwn(legalRoutes, pathname) ? legalRoutes[pathname] : null;
const LegalPage = lazy(() => import("./pages/LegalPage"));
const App = mode === "chain"
  ? lazy(() => import("./chain/ChainApp"))
  : lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p role="status" style={{ padding: 32 }}>Opening ZEDGE…</p>}>
      {legalPage ? <LegalPage page={legalPage} mode={mode} /> : <App />}
    </Suspense>
  </React.StrictMode>,
);
