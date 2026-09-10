/**
 * core/oauth/pkce — RFC 7636 Proof Key for Code Exchange (S256) and the
 * random `state` value, both from `node:crypto`.
 */

import { createHash, randomBytes } from "node:crypto";

export function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A verifier of 64 random bytes encodes to 86 unreserved characters (RFC 7636
 * §4.1 allows 43–128); the challenge is BASE64URL(SHA256(verifier)).
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier, "ascii").digest());
  return { verifier, challenge };
}

/** 32 random bytes, base64url: the `state` bound to one authorization request. */
export function randomState(): string {
  return base64url(randomBytes(32));
}
