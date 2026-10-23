import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: root,
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(root, "src/renderer"),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(root, "dist"),
    emptyOutDir: true,
  },
  server: {
    strictPort: true,
  },
});
