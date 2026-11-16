import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("public/v1", { recursive: true });

const common = {
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  legalComments: "none",
  sourcemap: false,
};

await build({
  ...common,
  entryPoints: ["src/sdk/ivt.ts"],
  outfile: "public/v1/ivt.js",
  banner: { js: "/* Thebes IVT browser sensor v2 */" },
});

// The ad loader is a separate file so ivt.js never contains GAM/ad-unit knowledge.
await build({
  ...common,
  entryPoints: ["src/sdk/ads.ts"],
  outfile: "public/v1/ads.js",
  banner: { js: "/* Thebes ad loader v1 */" },
});
