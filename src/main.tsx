import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
import { appMode } from "./chain/mode";
import "./styles.css";

const App = appMode(window.location.search, window.location.hash) === "chain"
  ? lazy(() => import("./chain/ChainApp"))
  : lazy(() => import("./App"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p role="status" style={{ padding: 32 }}>Opening ZEDGE…</p>}>
      <App />
    </Suspense>
  </React.StrictMode>,
);
