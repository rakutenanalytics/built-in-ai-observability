import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "..", "dist");
const staticDir = join(root, "..", "static");

mkdirSync(dist, { recursive: true });

const manifest = JSON.parse(
  readFileSync(join(staticDir, "manifest.json"), "utf8")
);
writeFileSync(
  join(dist, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);

for (const file of ["panel.html", "devtools.html", "panel.css"]) {
  copyFileSync(join(staticDir, file), join(dist, file));
}

console.log("Copied static extension assets to dist/");
