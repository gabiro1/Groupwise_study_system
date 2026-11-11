import crypto from "node:crypto";
import env from "../config/env.js";
import { AppError } from "../lib/errors.js";

const ALGORITHM = "aes-256-gcm";

function encryptionKey() {
  const raw = String(env.AI_CREDENTIAL_ENCRYPTION_KEY ?? "");
  if (raw.length < 32) {
    throw new AppError("AI credential encryption is not configured on the server.", {
      status: 503,
      code: "AI_CREDENTIAL_ENCRYPTION_UNAVAILABLE",
    });
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function encryptCredential(value) {
  const credential = String(value ?? "").trim();
  if (!credential) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptCredential(row) {
  if (!row?.credential_ciphertext || !row?.credential_iv || !row?.credential_tag) return null;
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(row.credential_iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(row.credential_tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.credential_ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError("The stored AI credential could not be decrypted.", {
      status: 503,
      code: "AI_CREDENTIAL_INVALID",
    });
  }
}

export function maskCredential(value) {
  const credential = String(value ?? "");
  if (!credential) return null;
  return `••••••••${credential.slice(-4)}`;
}
