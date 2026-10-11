import { readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Project lint.
 *
 * `node --check` is the only parser available without adding a toolchain, so this
 * runs it over every source file instead of just the entrypoint — a syntax error
 * in a route module that nothing imports yet is exactly the kind of thing that
 * otherwise surfaces at runtime.
 *
 * It additionally imports the Express app, which is the real check that every
 * route module, schema and service actually resolves. A missing named export in a
 * route file fails here rather than on the first request in production.
 *
 * Environment variables are stubbed because `env.js` validates on import; the
 * values are never used, since nothing connects during a syntax check.
 */

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "storage", "coverage"]);

/** Collect every .js file under a directory. */
function collect(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;

    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      collect(path, found);
    } else if (extname(path) === ".js") {
      found.push(path);
    }
  }

  return found;
}

const targets = [
  ...collect(join(ROOT, "src")),
  ...collect(join(ROOT, "tests")),
  ...collect(join(ROOT, "scripts")),
];

let failures = 0;

for (const file of targets) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failures += 1;
    process.stdout.write(`SYNTAX  ${relative(ROOT, file)}\n${error.stderr?.toString() ?? error.message}\n`);
  }
}

process.stdout.write(`Checked ${targets.length} files, ${failures} with syntax errors.\n`);

if (failures > 0) process.exit(1);

// The import check is the one that catches a missing export: `node --check` is
// purely syntactic and would happily accept a file importing a symbol that does
// not exist.
// Assigned onto `process.env` rather than kept aside: `env.js` reads it during
// import, so a local object would have no effect.
Object.assign(process.env, {
  NODE_ENV: process.env.NODE_ENV ?? "test",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://stub:stub@127.0.0.1:5432/lien_lint",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "00000000000000000000000000000000",
});

try {
  const { createApp } = await import(new URL("../src/config/app.js", import.meta.url).href);
  const app = createApp();

  // Express 5 no longer exposes its router on the app object, so routes are
  // verified by the fact that `createApp()` ran every `app.use` without throwing.
  // Counting handlers is not possible without reaching into internals, which
  // would make this check brittle across Express versions.
  process.stdout.write(`App built successfully (${app ? "express instance" : "no instance" }).\n`);
} catch (error) {
  process.stdout.write(`IMPORT  src/config/app.js\n${error.message}\n`);
  process.exit(1);
}