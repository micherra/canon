/**
 * Tests for identity-proof.ts — pure HMAC challenge-response proof module.
 *
 * Covers:
 * - proof round-trips (compute→verify true)
 * - wrong token → verify false
 * - wrong nonce → verify false
 * - different-length proof → false (no throw from timingSafeEqual)
 * - generateNonce returns distinct hex strings
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeIdentityProof, generateNonce, verifyIdentityProof } from "../identity-proof.ts";

// ---------------------------------------------------------------------------
// computeIdentityProof
// ---------------------------------------------------------------------------

describe("computeIdentityProof", () => {
  it("returns a 64-char hex string (SHA-256 digest)", () => {
    const proof = computeIdentityProof("my-token", "my-nonce");
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same token+nonce always produces the same proof", () => {
    const a = computeIdentityProof("token", "nonce");
    const b = computeIdentityProof("token", "nonce");
    expect(a).toBe(b);
  });

  it("matches manual node:crypto HMAC-SHA256 computation", () => {
    const token = "super-secret-token";
    const nonce = "random-nonce-value";
    const expected = createHmac("sha256", token).update(nonce).digest("hex");
    expect(computeIdentityProof(token, nonce)).toBe(expected);
  });

  it("different nonces produce different proofs (same token)", () => {
    const a = computeIdentityProof("token", "nonce-A");
    const b = computeIdentityProof("token", "nonce-B");
    expect(a).not.toBe(b);
  });

  it("different tokens produce different proofs (same nonce)", () => {
    const a = computeIdentityProof("token-A", "nonce");
    const b = computeIdentityProof("token-B", "nonce");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// verifyIdentityProof
// ---------------------------------------------------------------------------

describe("verifyIdentityProof", () => {
  it("returns true on round-trip (compute then verify with same token+nonce)", () => {
    const token = "test-token-32bytes-xxxxxxxxxxxx";
    const nonce = "nonce-abc123";
    const proof = computeIdentityProof(token, nonce);
    expect(verifyIdentityProof(token, nonce, proof)).toBe(true);
  });

  it("returns false when token differs (wrong token on verify)", () => {
    const nonce = "nonce-123";
    const proof = computeIdentityProof("correct-token", nonce);
    expect(verifyIdentityProof("wrong-token", nonce, proof)).toBe(false);
  });

  it("returns false when nonce differs (replayed proof)", () => {
    const token = "my-token";
    const proof = computeIdentityProof(token, "nonce-A");
    expect(verifyIdentityProof(token, "nonce-B", proof)).toBe(false);
  });

  it("returns false for an empty proof string (different length — no throw)", () => {
    const token = "token";
    const nonce = "nonce";
    // Empty string is shorter than a 64-char SHA-256 hex digest
    expect(() => verifyIdentityProof(token, nonce, "")).not.toThrow();
    expect(verifyIdentityProof(token, nonce, "")).toBe(false);
  });

  it("returns false for a truncated proof (different-length path — no throw)", () => {
    const token = "token";
    const nonce = "nonce";
    const proof = computeIdentityProof(token, nonce);
    const truncated = proof.slice(0, 32);
    expect(() => verifyIdentityProof(token, nonce, truncated)).not.toThrow();
    expect(verifyIdentityProof(token, nonce, truncated)).toBe(false);
  });

  it("returns false for a proof with invalid hex chars (different UTF-8 length)", () => {
    // A string with non-hex characters of same length that doesn't match
    const token = "token";
    const nonce = "nonce";
    const badProof = "x".repeat(64); // 64 chars but not a valid digest
    expect(verifyIdentityProof(token, nonce, badProof)).toBe(false);
  });

  it("does NOT throw for any proof length (timing-safe length guard)", () => {
    const token = "token";
    const nonce = "nonce";
    // Test many edge cases: empty, 1 char, 63 chars, 64 chars (wrong), 65 chars
    for (const len of [0, 1, 63, 64, 65, 128]) {
      const proof = "a".repeat(len);
      expect(() => verifyIdentityProof(token, nonce, proof)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// generateNonce
// ---------------------------------------------------------------------------

describe("generateNonce", () => {
  it("returns a hex string (only 0-9, a-f chars)", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]+$/);
  });

  it("returns a string of expected length (16 random bytes → 32 hex chars)", () => {
    const nonce = generateNonce();
    expect(nonce).toHaveLength(32);
  });

  it("generates distinct nonces on successive calls", () => {
    const nonces = new Set(Array.from({ length: 10 }, () => generateNonce()));
    // All 10 should be unique (collision probability is astronomically low)
    expect(nonces.size).toBe(10);
  });

  it("generates a nonce that can be used as a valid HMAC input", () => {
    const nonce = generateNonce();
    const proof = computeIdentityProof("some-token", nonce);
    expect(verifyIdentityProof("some-token", nonce, proof)).toBe(true);
  });
});
