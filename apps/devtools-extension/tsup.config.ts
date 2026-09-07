import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      interceptor: "src/interceptor/main.ts",
      bridge: "src/bridge/content-script.ts",
      background: "src/background/service-worker.ts",
      devtools: "src/devtools/devtools.ts",
      panel: "src/panel/panel.ts",
    },
    outDir: "dist",
    format: ["esm"],
    splitting: false,
    sourcemap: true,
    clean: true,
    platform: "browser",
    target: "chrome120",
    noExternal: [/.*/],
    outExtension: () => ({ js: ".js" }),
  },
]);
