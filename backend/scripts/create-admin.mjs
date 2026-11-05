#!/usr/bin/env node
/**
 * Provision an administrator account.
 *
 * This exists because the product must never ship a hardcoded admin password, and
 * public registration must never be able to create an ADMIN. An operator runs this
 * once, on the server, with database credentials already in the environment.
 *
 * Usage:
 *   npm run create:admin
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_FIRST_NAME=... ADMIN_LAST_NAME=... npm run create:admin
 *
 * Security properties:
 *   - The password is never printed, logged or stored in shell history when the
 *     interactive prompt is used (input is read with echo disabled).
 *   - It is validated against the same policy as normal registration.
 *   - An existing account is never silently promoted; that is a privileged action
 *     and belongs in the audit-trailed admin console.
 *   - The creation is written to `audit_logs` as `admin.bootstrap.created`.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { queryOne, withTransaction, closePool } from "../src/config/db.js";
import { hashPassword } from "../src/lib/crypto.js";
import { password as passwordSchema } from "../src/lib/schemas.js";
import { recordAudit, AUDIT } from "../src/lib/audit.js";
import { USER_STATUS } from "../src/config/constants.js";

/** Read a line without echoing it to the terminal. */
async function promptHidden(question) {
  if (!input.isTTY) {
    // Piped input: read a single line normally.
    const rl = createInterface({ input, output });
    const answer = await rl.question(question);
    rl.close();
    return answer;
  }

  output.write(question);
  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    input.setEncoding("utf8");
    input.resume();
    input.setRawMode(true);
    input.on("data", onData);
  });
}

async function collectDetails() {
  const fromEnv = {
    email: process.env.ADMIN_EMAIL ?? "",
    password: process.env.ADMIN_PASSWORD ?? "",
    firstName: process.env.ADMIN_FIRST_NAME ?? "",
    lastName: process.env.ADMIN_LAST_NAME ?? "",
  };

  if (fromEnv.email && fromEnv.password && fromEnv.firstName && fromEnv.lastName) {
    return fromEnv;
  }

  if (!input.isTTY) {
    throw new Error(
      "Missing administrator details. Set ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME and ADMIN_LAST_NAME.",
    );
  }

  const rl = createInterface({ input, output });
  try {
    const email = (await rl.question(`Admin email${fromEnv.email ? ` [${fromEnv.email}]` : ""}: `)).trim() || fromEnv.email;
    const firstName =
      (await rl.question(`First name${fromEnv.firstName ? ` [${fromEnv.firstName}]` : ""}: `)).trim() ||
      fromEnv.firstName;
    const lastName =
      (await rl.question(`Last name${fromEnv.lastName ? ` [${fromEnv.lastName}]` : ""}: `)).trim() ||
      fromEnv.lastName;

    let password = fromEnv.password;
    if (!password) {
      password = await promptHidden("Password (input hidden): ");
      const confirmation = await promptHidden("Confirm password: ");
      if (password !== confirmation) throw new Error("The passwords do not match.");
    }

    return { email, password, firstName, lastName };
  } finally {
    rl.close();
  }
}

function validate({ email, password, firstName, lastName }) {
  const fields = {};

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = "Enter a valid email address.";
  if (!firstName.trim()) fields.firstName = "Enter a first name.";
  if (!lastName.trim()) fields.lastName = "Enter a last name.";

  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) {
    fields.password = parsed.error.issues[0]?.message ?? "That password does not meet the policy.";
  }

  if (Object.keys(fields).length) {
    const error = new Error("Please correct the following:");
    error.fields = fields;
    throw error;
  }
}

async function main() {
  const details = await collectDetails();
  const email = details.email.trim().toLowerCase();
  const firstName = details.firstName.trim();
  const lastName = details.lastName.trim();

  validate({ ...details, email, firstName, lastName });

  const existing = await queryOne(
    "SELECT id, deleted_at FROM users WHERE email = $1",
    [email],
    "bootstrap:existingUser",
  );

  if (existing && !existing.deleted_at) {
    throw new Error(
      "An account with that email already exists. Promote it from the admin console so the change is audited.",
    );
  }

  const passwordHash = await hashPassword(details.password);

  const created = await withTransaction(async (tx) => {
    const role = await tx.queryOne("SELECT id FROM roles WHERE key = 'ADMIN'", [], "bootstrap:role");
    if (!role) {
      throw new Error("The ADMIN role is missing. Run the database seed or migrations first.");
    }

    let user;
    if (existing) {
      // A soft-deleted account is reused rather than duplicated, keeping its id
      // and audit history intact.
      user = await tx.queryOne(
        `UPDATE users
            SET password_hash = $2, role_id = $3, status = $4, first_name = $5, last_name = $6,
                email_verified_at = now(), password_changed_at = now(), must_change_password = FALSE,
                deleted_at = NULL, suspended_at = NULL, suspension_reason = NULL,
                failed_login_count = 0, locked_until = NULL, updated_at = now()
          WHERE id = $1
          RETURNING id, email, first_name, last_name, status, created_at`,
        [existing.id, passwordHash, role.id, USER_STATUS.ACTIVE, firstName, lastName],
        "bootstrap:restoreAdmin",
      );
    } else {
      user = await tx.queryOne(
        `INSERT INTO users
           (email, password_hash, role_id, status, first_name, last_name,
            email_verified_at, password_changed_at, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now(), FALSE)
         RETURNING id, email, first_name, last_name, status, created_at`,
        [email, passwordHash, role.id, USER_STATUS.ACTIVE, firstName, lastName],
        "bootstrap:insertAdmin",
      );
    }

    await recordAudit(
      {
        actor: null,
        action: AUDIT.ADMIN_BOOTSTRAP,
        entityType: "user",
        entityId: user.id,
        metadata: { email: user.email, source: "provisioning-script", reusedDeletedAccount: Boolean(existing) },
      },
      { tx },
    );

    return user;
  }, "bootstrap:createAdmin");

  output.write(
    [
      "",
      "Administrator account ready.",
      `  Email: ${created.email}`,
      `  Name:  ${created.first_name} ${created.last_name}`,
      `  Id:    ${created.id}`,
      "",
      "The password was not stored or printed. Sign in and change it if it was shared.",
      "",
    ].join("\n"),
  );
}

main()
  .catch((error) => {
    if (error.fields) {
      output.write(`\n${error.message}\n`);
      for (const [field, message] of Object.entries(error.fields)) output.write(`  - ${field}: ${message}\n`);
    } else {
      output.write(`\nCould not create the administrator: ${error.message}\n`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
