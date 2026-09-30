import { defineConfig } from "tsdown";

const extensionBuildDefaults = {
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
  dts: false,
  format: ["esm"] as const,
  outDir: "dist",
  outExtensions: () => ({ js: ".js" }),
  platform: "browser" as const,
  sourcemap: true,
  target: "chrome120" as const,
};

const entries = {
  background: "src/background/service-worker.ts",
  bridge: "src/bridge/content-script.ts",
  devtools: "src/devtools/devtools.ts",
  interceptor: "src/interceptor/main.ts",
  panel: "src/panel/panel.ts",
};

export default defineConfig(
  Object.entries(entries).map(([name, entry], index) => ({
    ...extensionBuildDefaults,
    clean: index === 0,
    copy:
      index === 0
        ? {
            flatten: true,
            from: "static/**/*",
            to: "dist",
          }
        : undefined,
    entry: { [name]: entry },
  }))
);
