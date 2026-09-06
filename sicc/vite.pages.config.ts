import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  root: "github-pages",
  publicDir: "../public",
  build: {
    outDir: "../../pages-dist",
    emptyOutDir: true,
  },
});
