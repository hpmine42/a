import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // Relative base on purpose: the build has to work at "/", at "/<repo>/" on
  // GitHub Pages and under a renamed repo or custom domain without a rebuild.
  // An absolute base is the classic reason a Pages deploy shows a blank page —
  // index.html loads, then every asset under /assets/... 404s.
  base: "./",
  plugins: [vue()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // the sandbox preview proxies through a generated *.e2b.app hostname
    allowedHosts: [".e2b.app", "localhost"],
  },
});
