// Builds provenance/demo/index.html: one self-contained file (logic + UI inlined).
// Open it directly from disk (file://). No server, no network, no external scripts.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["provenance/demo/app.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  write: false,
  legalComments: "none",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile("provenance/demo/template.html", "utf8");
const out = "provenance/demo/index.html";
await writeFile(out, template.replace("/*__BUNDLE__*/", () => js));
console.log(`wrote ${out} (${Math.round((template.length + js.length) / 1024)} KB)`);
