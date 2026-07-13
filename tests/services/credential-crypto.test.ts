import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials } from "../../src/services/credential-crypto.js";

describe("credential-crypto", () => {
  it("encrypts and decrypts credentials roundtrip", () => {
    const plain = { token: "secret-token-123", refreshToken: "rt-456" };
    const encrypted = encryptCredentials(plain);
    expect(encrypted).toBeTruthy();
    expect(typeof encrypted).toBe("string");

    // Should be a JSON object with iv, data, and tag
    const parsed = JSON.parse(encrypted);
    expect(parsed.iv).toBeTruthy();
    expect(parsed.data).toBeTruthy();
    expect(parsed.tag).toBeTruthy();

    const decrypted = decryptCredentials(encrypted);
    expect(decrypted).toEqual(plain);
  });

  it("produces different ciphertext for the same plaintext (non-deterministic IV)", () => {
    const plain = { token: "same-value" };
    const e1 = encryptCredentials(plain);
    const e2 = encryptCredentials(plain);
    expect(e1).not.toBe(e2);
  });

  it("handles empty credentials object", () => {
    const encrypted = encryptCredentials({});
    const decrypted = decryptCredentials(encrypted);
    expect(decrypted).toEqual({});
  });

  it("handles legacy plaintext JSON gracefully on decrypt", () => {
    const legacyJson = '{"token":"legacy","refresh":"abc"}';
    const result = decryptCredentials(legacyJson);
    expect(result).toEqual({ token: "legacy", refresh: "abc" });
  });

  it("returns empty object for invalid ciphertext", () => {
    const result = decryptCredentials("not-json-at-all");
    expect(result).toEqual({});
  });
});
