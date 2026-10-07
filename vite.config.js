import { defineConfig } from "vite";

export default defineConfig({
  base: "/centur/",
  server: {
    host: true,
    port: 5176,
  },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
  },
});