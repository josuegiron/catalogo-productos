import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Reemplaza "mi-repo" por el nombre exacto del repo si vas a GitHub Pages.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? "/catalogo-productos/" : "/",
});