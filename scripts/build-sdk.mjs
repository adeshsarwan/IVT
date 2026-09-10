import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("public/v1", { recursive: true });

await build({
  entryPoints: ["src/sdk/ivt.ts"],
  outfile: "public/v1/ivt.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  legalComments: "none",
  sourcemap: false,
  banner: { js: "/* Thebes IVT browser sensor v2 */" },
});
