import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `vite --mode fork` serves the fork end-to-end run: the relay test server answers /api and the fork's order book manifest.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: mode === "fork"
    ? { strictPort: true, host: "127.0.0.1", port: 4189, proxy: { "/api": "http://127.0.0.1:39845", "/deployments/26514-orderbook.json": "http://127.0.0.1:39845" } }
    : { strictPort: true },
}));
