// Builds a single self-contained HTML page that runs the real Worker + SDK in the browser.
// Output goes to .wrangler/demo/ (never public/, so it can't be deployed with the Worker).
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const result = await build({
  entryPoints: ["demo/adpass-demo.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  write: false,
  legalComments: "none",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const gate = (await readFile("docs/ad-pass/ad-gate.js", "utf8")).replace(/<\/script/gi, "<\\/script");
const template = await readFile("demo/template.html", "utf8");
await mkdir(".wrangler/demo", { recursive: true });
const out = ".wrangler/demo/ad-pass-demo.html";
await writeFile(out, template.replace("/*__GATE__*/", () => gate).replace("/*__BUNDLE__*/", () => js));
console.log(`wrote ${out} (${Math.round((template.length + js.length) / 1024)} KB)`);
