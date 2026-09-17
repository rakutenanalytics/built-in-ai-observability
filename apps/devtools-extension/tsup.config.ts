import { defineConfig } from "tsup";

export default defineConfig([
  {
    clean: true,
    entry: {
      background: "src/background/service-worker.ts",
      bridge: "src/bridge/content-script.ts",
      devtools: "src/devtools/devtools.ts",
      interceptor: "src/interceptor/main.ts",
      panel: "src/panel/panel.ts",
    },
    format: ["esm"],
    noExternal: [/.*/],
    outDir: "dist",
    outExtension: () => ({ js: ".js" }),
    platform: "browser",
    sourcemap: true,
    splitting: false,
    target: "chrome120",
  },
]);
