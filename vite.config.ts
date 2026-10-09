import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite --mode fork` serves the fork end-to-end run: the relay test server answers /api and the fork's order book and events
// manifests, and a local indexer the read API (/v1, which vercel.json sends to the indexer in production; the indexer answers only the
// application's own origin, which the rewrite keeps in production).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: mode === "fork"
    ? { strictPort: true, host: "127.0.0.1", port: 4189, proxy: { "/api": "http://127.0.0.1:39845", "/deployments/26514-orderbook.json": "http://127.0.0.1:39845",
      "/deployments/26514-events.json": "http://127.0.0.1:39845", "/v1": { target: "http://127.0.0.1:39846", headers: { origin: "https://zedge-markets.vercel.app" } } } }
    : { strictPort: true },
}));
