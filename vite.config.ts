import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // solo si tu index.html NO está en la raíz:
  root: "frontend",
  base: process.env.GITHUB_PAGES ? "/catalogo-productos/" : "/",
  build: { outDir: "dist", emptyOutDir: true }
});
