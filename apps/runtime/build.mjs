import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const src = new URL("./src/", import.meta.url);
const entries = (await readdir(src, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => new URL(entry.name, src).pathname)
  .sort();

/** Keep versioned runtime dependencies external while embedding first-party workspace TypeScript. */
const externalizeDependencies = {
  name: "externalize-dependencies",
  setup(api) {
    api.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@occavoy/") || args.path === "zod") return null;
      return { path: args.path, external: true };
    });
  },
};

const outdir = fileURLToPath(new URL("./dist/", import.meta.url));
await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: entries,
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node26",
  sourcemap: true,
  plugins: [externalizeDependencies],
  logLevel: "warning",
});
