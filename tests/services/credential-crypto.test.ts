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

  it("uses 12-byte IV (24 hex chars) per NIST GCM recommendation", () => {
    const encrypted = encryptCredentials({ token: "x" });
    const parsed = JSON.parse(encrypted);
    expect(parsed.iv).toMatch(/^[0-9a-f]{24}$/);
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

  it("returns empty object when ciphertext is tampered with (decryption failure)", () => {
    const plain = { token: "secret" };
    const encrypted = encryptCredentials(plain);
    const parsed = JSON.parse(encrypted);

    // Tamper with the ciphertext
    const tampered = JSON.stringify({ iv: parsed.iv, data: "deadbeef", tag: parsed.tag });
    const result = decryptCredentials(tampered);
    expect(result).toEqual({});

    // Tamper with the auth tag
    const tamperedTag = JSON.stringify({ iv: parsed.iv, data: parsed.data, tag: "00000000000000000000000000000000" });
    const result2 = decryptCredentials(tamperedTag);
    expect(result2).toEqual({});

    // Tamper with the IV
    const tamperedIv = JSON.stringify({ iv: "000000000000000000000000", data: parsed.data, tag: parsed.tag });
    const result3 = decryptCredentials(tamperedIv);
    expect(result3).toEqual({});
  });

  it("throws in production when PUBLISH_CREDENTIALS_KEY is not set", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origKey = process.env.PUBLISH_CREDENTIALS_KEY;

    process.env.NODE_ENV = "production";
    delete process.env.PUBLISH_CREDENTIALS_KEY;

    expect(() => encryptCredentials({ token: "x" })).toThrow(
      "PUBLISH_CREDENTIALS_KEY"
    );

    process.env.NODE_ENV = origNodeEnv;
    if (origKey !== undefined) {
      process.env.PUBLISH_CREDENTIALS_KEY = origKey;
    } else {
      delete process.env.PUBLISH_CREDENTIALS_KEY;
    }
  });
});
