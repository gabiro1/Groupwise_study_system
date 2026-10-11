import { readFileSync, writeFileSync } from "node:fs";

const path = "src/routes/admin.routes.js";
let source = readFileSync(path, "utf8");

// Collapse the verbose actor/ip argument shape into the API recordAudit expects.
source = source.replaceAll("writeAudit(", "recordAudit(");

source = source.replaceAll(
  /\n\s*actorId: req\.user\.id,\s*\n\s*actorRole: req\.user\.role,\n/g,
  "\n          actor: req.user,\n          req,\n",
);

source = source.replaceAll(
  /\n\s*actorId: req\.user\.id,\s*\n\s*actorRole: req\.user\.role,\s*\n/g,
  "actor: req.user,\n",
);

// Standalone (non-transactional) calls pass ip/user-agent via `req`.
source = source.replaceAll(/\n\s*ip: req\.ip,\n\s*userAgent: req\.get\("user-agent"\),\n/g, "\n");
source = source.replaceAll(/\n\s*ip: req\.ip,\s*\n\s*userAgent: req\.get\("user-agent"\),\s*\n/g, "\n");

source = source.replaceAll(
  'import { writeAudit } from "../lib/audit.js";',
  'import { recordAudit, AUDIT } from "../lib/audit.js";',
);

writeFileSync(path, source);

console.log("writeAudit left:", (source.match(/writeAudit/g) ?? []).length);
console.log("actorId left:", (source.match(/actorId/g) ?? []).length);
console.log("userAgent left:", (source.match(/userAgent/g) ?? []).length);
console.log("recordAudit calls:", (source.match(/recordAudit\(/g) ?? []).length);