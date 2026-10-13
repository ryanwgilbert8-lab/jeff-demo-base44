import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

// AES-256-GCM for Plaid access tokens at rest. Format: v1.<iv>.<tag>.<ciphertext>, base64url.
const key = () => {
  const k = Buffer.from(env("TOKEN_ENCRYPTION_KEY"), "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return k;
};

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), data].map(x => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1") throw new Error("Unknown token format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
