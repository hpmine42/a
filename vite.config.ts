import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    // the sandbox preview proxies through a generated *.e2b.app hostname
    allowedHosts: [".e2b.app", "localhost"],
  },
});
