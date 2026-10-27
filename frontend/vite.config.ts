import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Keep the browser's prebundles separate from Vitest's optimizer cache.
  cacheDir: "node_modules/.vite-dev",
  optimizeDeps: {
    // MapView is lazy-loaded, but Leaflet must be ready on the first visit.
    include: [
      "react",
      "react-dom/client",
      "react/jsx-runtime",
      "leaflet",
      "lucide-react",
      "recharts",
    ],
  },
  server: {
    port: 5174,
    strictPort: true,
    warmup: { clientFiles: ["./src/MapView.tsx"] },
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
});
