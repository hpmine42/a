import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // GitHub Pages serves project sites from /<repo>/, local dev from /
  base: process.env.VITE_BASE ?? "/",
  plugins: [vue()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // the sandbox preview proxies through a generated *.e2b.app hostname
    allowedHosts: [".e2b.app", "localhost"],
  },
});
