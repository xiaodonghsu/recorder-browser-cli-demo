import { defineConfig } from "vite";

export default defineConfig({
  // Keep the same build deployable at / or any Nginx subdirectory.
  base: "./",
});
