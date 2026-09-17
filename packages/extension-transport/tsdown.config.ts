import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/protocol.ts"],
  format: ["esm"],
  outExtensions: () => ({ js: ".js" }),
  sourcemap: true,
  target: false,
});
