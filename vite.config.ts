import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; set VITE_BASE=/ for root hosting.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./supabase/functions/_shared", import.meta.url)) },
  },
  test: { environment: "node", testTimeout: 20000, fileParallelism: false },
} as any);
