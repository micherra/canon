/**
 * Canon daemon identity proof — HMAC challenge-response module.
 *
 * Used on the EADDRINUSE probe path (F4 hardening) to prove that an
 * existing process holding the daemon port possesses the same 0600 token
 * as the probing daemon — defending against a token-less impostor that
 * serves a matching `/health` version to cheaply force `process.exit(0)`.
 *
 * ## Security model
 * - Proof = HMAC-SHA256_token(nonce): keyed on the 0600 token, bound to a
 *   fresh nonce per probe → non-replayable, proves LIVE token possession.
 * - `/identity` route returns ONLY the HMAC digest, never the raw token.
 * - `verifyIdentityProof` uses `timingSafeEqual` with a length-guard so
 *   it NEVER throws on mismatched buffer lengths.
 * - Does NOT defend against a same-user process that has already READ the
 *   token (that adversary is in the F1 "game-over" trust class, a separately
 *   documented and signed-off residual risk).
 *
 * ## Module composition
 * - Pure crypto functions (generateNonce, computeIdentityProof, verifyIdentityProof):
 *   no I/O, no global state — safe to import in tests without any setup.
 * - Network probe (probeIdentity): makes an authenticated HTTP GET /identity
 *   request to the incumbent daemon and verifies its proof. Extracted here
 *   from daemon.ts for line-budget compliance and cohesion.
 *
 * @see docs/adr/0003-daemon-identity-proof-on-eaddrinuse-probe.md
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically random nonce for use as the challenge in the
 * HMAC identity proof exchange.
 *
 * @returns A 32-character lowercase hex string (16 random bytes).
 */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Computes an HMAC-SHA256 identity proof for a given token and nonce.
 *
 * The proof is keyed on the 0600 daemon token and bound to the nonce, making
 * it non-replayable — a scraped response is useless for a different nonce.
 *
 * @param token - The daemon's secret token (0600 file content).
 * @param nonce - A per-probe random challenge (from generateNonce).
 * @returns A 64-character lowercase hex string (SHA-256 digest).
 */
export function computeIdentityProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(nonce).digest("hex");
}

/**
 * Verifies an HMAC identity proof using a timing-safe comparison.
 *
 * Guards against unequal-length inputs: `timingSafeEqual` throws when
 * buffer lengths differ, so this function short-circuits with `false`
 * before calling it. This ensures no exception leaks from length mismatches
 * (e.g. empty string, truncated proof, wrong encoding).
 *
 * @param token - The expected token (local daemon's 0600 token).
 * @param nonce - The challenge nonce that was sent to the incumbent.
 * @param proof - The proof returned by the incumbent's `/identity` route.
 * @returns `true` if proof is valid; `false` on any mismatch or length
 *   difference (never throws).
 */
export function verifyIdentityProof(token: string, nonce: string, proof: string): boolean {
  const expected = computeIdentityProof(token, nonce);
  // Convert to UTF-8 Buffers for timingSafeEqual (proofs are ASCII hex, so
  // UTF-8 and Latin-1 lengths are identical — no encoding edge case here).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(proof, "utf8");
  // Length-guard BEFORE timingSafeEqual — the function throws on unequal lengths.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Network probe — extracted from daemon.ts for line-budget compliance
// ---------------------------------------------------------------------------

/**
 * Parses a raw HTTP response body from the /identity endpoint and verifies
 * the proof. Extracted to keep probeIdentity under the Biome cognitive
 * complexity limit.
 *
 * @returns `"same-version"` when the proof is valid; `"identity-mismatch"` otherwise.
 */
function parseIdentityResponse(
  statusCode: number | undefined,
  body: string,
  token: string,
  nonce: string,
): "same-version" | "identity-mismatch" {
  if (statusCode !== 200) return "identity-mismatch";
  try {
    const parsed = JSON.parse(body) as { proof?: string };
    if (typeof parsed.proof === "string" && verifyIdentityProof(token, nonce, parsed.proof)) {
      return "same-version";
    }
    return "identity-mismatch";
  } catch {
    return "identity-mismatch";
  }
}

/**
 * Calls the incumbent daemon's authenticated GET /identity?nonce=<n> endpoint
 * and verifies that the returned proof matches the expected HMAC.
 *
 * Extracted from daemon.ts to keep daemon.ts under the 600-line Biome limit.
 * Cohesive with identity-proof.ts: this is the network layer of the challenge-
 * response exchange; the crypto layer (computeIdentityProof / verifyIdentityProof)
 * is already here.
 *
 * On any failure (network, auth, parse, timeout, wrong proof) → `"identity-mismatch"`.
 * On valid proof → `"same-version"`.
 *
 * @param port      - Port to probe.
 * @param token     - The local daemon's token (used both as Bearer auth and HMAC key).
 * @param nonce     - Fresh random nonce for this probe (from generateNonce).
 * @param timeoutMs - Request timeout in milliseconds.
 */
export function probeIdentity(
  port: number,
  token: string,
  nonce: string,
  timeoutMs: number,
): Promise<"same-version" | "identity-mismatch"> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        headers: {
          authorization: `Bearer ${token}`,
          host: "127.0.0.1",
        },
        hostname: "127.0.0.1",
        method: "GET",
        path: `/identity?nonce=${encodeURIComponent(nonce)}`,
        port,
        timeout: timeoutMs,
      },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve(parseIdentityResponse(res.statusCode, body, token, nonce));
        });
      },
    );
    req.on("error", () => resolve("identity-mismatch"));
    req.on("timeout", () => {
      req.destroy();
      resolve("identity-mismatch");
    });
    req.end();
  });
}
