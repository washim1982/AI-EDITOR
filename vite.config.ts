import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Vite otherwise discovers every nested HTML file as an optimization entry.
  // The vendored Code-OSS checkout contains its own workbench HTML and sources,
  // which belong to Code-OSS's build pipeline rather than this React renderer.
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/vendor/**", "**/release/**", "**/dist*/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    sourcemap: true,
  },
});
