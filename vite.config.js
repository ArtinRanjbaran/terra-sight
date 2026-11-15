import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/examples/")) return "three-controls";
          if (id.includes("/node_modules/three/")) return "three-vendor";
          return undefined;
        },
      },
    },
  },
});
