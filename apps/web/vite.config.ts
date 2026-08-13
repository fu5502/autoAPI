import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/admin": process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8080",
      "/auth-assistant": process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8080",
      "/healthz": process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8080",
      "/latest-version": process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8080",
    },
  },
});
