import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Schema cross-check.
 *
 * Every column a service references must exist on the table it is read from. This is
 * the class of bug a JavaScript project with no ORM cannot catch any other way:
 *
 *   `SELECT r.created_at FROM recommendations r` parses fine, type-checks fine,
 *   passes review, and then fails at runtime with "column r.created_at does not
 *   exist" - on one code path, for one filter, long after it was written.
 *
 * The check has no database behind it. It reads the `CREATE TABLE` definitions (and
 * any later `ALTER TABLE ... ADD COLUMN`) out of the migrations and compares them
 * against the qualified references in the service SQL. It cannot see anything it
 * does not have a definition for, so it is a floor and not a proof - but it caught
 * real bugs when it was written, which is the only justification for keeping it.
 *
 * Known limits, stated so the next person does not trust it more than it deserves:
 *
 *   * Only `alias.column` references are checked. A bare column in a single-table
 *     query is inferred from the surrounding words and skipped, because "status" in
 *     a `WHERE` clause is genuinely ambiguous between SQL and the surrounding JS.
 *   * A table is only recognised if it has a `CREATE TABLE` in the migrations.
 *     Views, functions and CTE names are not tracked.
 *   * Generated tsvector columns added by `ALTER TABLE` are handled, because without
 *     that they read as missing.
 */

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MIGRATIONS = join(ROOT, "src/db/migrations");

/** table name -> Map(column -> declared type) */
const tables = new Map();

/** enum type name -> members */
const enums = new Map();

/** Pending enum validations: { where, type, value }. */
const enumChecks = [];

for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
  const sql = readFileSync(join(MIGRATIONS, name), "utf8");

  // Enum types and their members. `task_status` spelling its final value
  // `COMPLETED` while the code says `DONE` is a runtime failure at best, and a
  // silent mismatch in a trigger at worst.
  for (const type of sql.matchAll(/CREATE TYPE\s+([a-z_][a-z0-9_]*)\s+AS ENUM\s*\(([^)]*)\)/gi)) {
    enums.set(
      type[1].toLowerCase(),
      type[2]
        .split(",")
        .map((value) => value.trim().replace(/^'|'$/g, ""))
        .filter(Boolean),
    );
  }

  // Later migrations extend an existing enum; without this the constants check
  // below would reject values that Postgres does accept, in both directions.
  for (const add of sql.matchAll(/ALTER TYPE\s+([a-z_][a-z0-9_]*)\s+ADD VALUE(?:\s+IF NOT EXISTS)?\s+'([^']+)'/gi)) {
    enums.get(add[1].toLowerCase())?.push(add[2]);
  }

  const create = /CREATE TABLE(?: IF NOT EXISTS)? ([\w.]+)\s*\(([\s\S]*?)\n\);/g;
  let match;
  while ((match = create.exec(sql))) {
    const table = match[1].replace(/^public\./, "");
    const columns = new Map();

    for (const line of match[2].split("\n")) {
      const clean = line.replace(/--.*$/, "").trim();
      const column = clean.match(/^([a-z_][a-z0-9_]*)\s+([a-z_][a-z0-9_]*)/i);
      if (!column) continue;

      columns.set(column[1], column[2].toLowerCase());

      // An inline `column type DEFAULT 'VALUE'` is checked against the same enum
      // list, so a default that no longer exists is caught here rather than when the
      // first row is inserted.
      const fallback = clean.match(/DEFAULT\s+'([^']+)'/i);
      if (fallback && enums.has(column[2].toLowerCase())) {
        enumChecks.push({ where: `${name}: ${table}.${column[1]} default`, type: column[2], value: fallback[1] });
      }
    }

    tables.set(table, columns);
  }

  // Columns added after the fact (generated search documents) are part of the
  // schema; treating them as missing would train us to ignore the check.
  // One `ALTER TABLE` can carry several comma-separated `ADD COLUMN`s, so the
  // column pickups are matched inside each ALTER statement individually.
  const alterStatement = /ALTER TABLE\s+([\w.]+)\s*([\s\S]*?);/gi;
  let alterMatch;
  while ((alterMatch = alterStatement.exec(sql))) {
    const table = alterMatch[1].replace(/^public\./, "");
    const block = alterMatch[2];
    const addColumn = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s+([a-z_][a-z0-9_]*)/gi;
    let column;
    while ((column = addColumn.exec(block))) {
      tables.get(table)?.set(column[1].toLowerCase(), column[2].toLowerCase());
    }
  }
}

/** Column names that appear as `x.count` / `x.now` in JavaScript, not SQL. */
const NOT_A_COLUMN = new Set(["count", "now", "length", "map", "filter", "push", "slice"]);

const KEYWORDS_AFTER_TABLE = new Set([
  "set", "select", "values", "where", "on", "using", "and", "or", "group", "order", "join", "lateral",
]);

function collectJs(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (["node_modules", ".git", "storage", "coverage"].includes(entry)) continue;

    const path = join(directory, entry);
    if (statSync(path).isDirectory()) collectJs(path, found);
    else if (path.endsWith(".js")) found.push(path);
  }

  return found;
}

const problems = new Set();
let statements = 0;

for (const file of collectJs(join(ROOT, "src"))) {
  const source = readFileSync(file, "utf8");

  // Every template literal, including short ones. Requiring a minimum length makes
  // a match start on a short literal's *closing* backtick and swallow the
  // JavaScript that follows it, which then produces nonsense findings.
  for (const literal of source.matchAll(/`([^`]*)`/g)) {
    const sql = literal[1];

    const head = sql
      .replace(/^\s*(\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*|--[^\n]*\n\s*)+/, "")
      .trimStart();
    if (!/^(SELECT|WITH|UPDATE|DELETE|INSERT)\b/i.test(head)) continue;

    statements += 1;

    // alias -> table, from FROM/JOIN/INTO/UPDATE.
    const aliases = new Map();

    for (const reference of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z][a-z0-9_]*))?/gi)) {
      const table = reference[1].toLowerCase();
      if (!tables.has(table)) continue;

      aliases.set(table, table);

      const alias = reference[2]?.toLowerCase();
      if (alias && !KEYWORDS_AFTER_TABLE.has(alias)) aliases.set(alias, table);
    }

    for (const [alias, table] of aliases) {
      const columns = tables.get(table);
      const reference = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, "g");

      let column;
      while ((column = reference.exec(sql))) {
        if (NOT_A_COLUMN.has(column[1])) continue;
        if (columns.has(column[1])) continue;

        problems.add(`${relative(ROOT, file)}: ${alias}.${column[1]} is not a column of ${table}`);
        continue;
      }

      // Enum comparison: `WHERE s.status = 'CANCELLED'`. Only checked when the column's
      // declared type is an enum the migrations define, so `timestamptz = '...'` and
      // friends are never in scope.
      for (const [name, type] of columns) {
        if (!enums.has(type)) continue;

        const comparison = new RegExp(`\\b${alias}\\.${name}\\s*(?:=|<>|!=)\\s*'([^']+)'`, "g");

        let value;
        while ((value = comparison.exec(sql))) {
          enumChecks.push({
            where: `${relative(ROOT, file)}: ${alias}.${name} = '${value[1]}'`,
            type,
            value: value[1],
          });
        }
      }
    }
  }
}

// Every exported constant object in `config/constants.js` must consist of values that
// some enum in the migrations accepts. This is what catches `TASK_STATUS: "DONE"`
// when the column is a `task_status` spelled `COMPLETED`, and it costs nothing at
// runtime because the constants are the only vocabulary the code writes.
{
  const constantsPath = join(ROOT, "src/config/constants.js");
  const constants = readFileSync(constantsPath, "utf8");
  const blocks = constants.matchAll(/export const ([A-Z0-9_]+) = Object\.freeze\(\{([^}]*)\}\)/g);

  for (const block of blocks) {
    const [, name, body] = block;

    // A frozen object of non-enum things (group size limits, pagination defaults).
    const values = [...body.matchAll(/:\s*"([A-Z0-9_]+)"/g)].map((value) => value[1]);
    if (values.length === 0) continue;

    // Only check blocks whose name matches its contents, so an arbitrary mapping
    // table (label maps, for instance) is not mistaken for an enum.
    if (values.some((value) => value !== name.replace(/^[A-Z]+_/, ""))) {
      const looksLikeEnum = values.every((value) => value.length > 2 && value === value.toUpperCase());
      if (!looksLikeEnum) continue;
    }

    for (const value of values) {
      const known = [...enums.values()].some((members) => members.includes(value));
      if (!known) {
        enumChecks.push({ where: `constants.js: ${name}.${value}`, type: null, value });
      }
    }
  }
}

const enumProblems = new Set();

for (const check of enumChecks) {
  if (check.type === null) {
    enumProblems.add(`${check.where} is not a member of any enum in the migrations`);
    continue;
  }

  if (!enums.get(check.type).includes(check.value)) {
    enumProblems.add(
      `${check.where} is not valid for enum ${check.type} (allowed: ${enums.get(check.type).join(", ")})`,
    );
  }
}

if (problems.size > 0) {
  process.stdout.write(`SCHEMA\n${[...problems].sort().join("\n")}\n`);
}

if (enumProblems.size > 0) {
  process.stdout.write(`ENUMS\n${[...enumProblems].sort().join("\n")}\n`);
}

if (problems.size > 0 || enumProblems.size > 0) process.exit(1);

process.stdout.write(
  `Schema cross-check passed (${tables.size} tables, ${statements} SQL statements, ${enums.size} enums).\n`,
);