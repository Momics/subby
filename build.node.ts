// ex. scripts/build_npm.ts
import { build, emptyDir } from "https://deno.land/x/dnt@0.30.0/mod.ts";

await emptyDir("./npm");

await build({
  typeCheck: false,
  entryPoints: ["./client.ts"],
  outDir: "./npm",
  shims: {
    // see JS docs for overview and more options
    deno: true,
  },
  package: {
    // package.json properties
    name: "subby-ws",
    version: Deno.args[0],
    description: "Create real-time subscription based API's with WebSocket.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/momics/repo.git",
    },
    bugs: {
      url: "https://github.com/momics/repo/issues",
    },
    dependencies: {
      msgpackr: "^1.6.2",
    },
  },
  compilerOptions: {
    lib: ["es2021", "dom"],
  },
});

// post build steps
Deno.copyFileSync("LICENSE", "npm/LICENSE");
Deno.copyFileSync("README.md", "npm/README.md");
