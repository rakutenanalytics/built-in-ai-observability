import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/protocol.ts"],
  format: ["esm"],
  sourcemap: true,
});
