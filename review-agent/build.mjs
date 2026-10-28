// Bundles the pack into dist/index.js, the one file every action and the CLI run.
// dist is committed: an action runs from the repository as it is, with no install.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // The actions libraries reach CommonJS dependencies through require.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
});
