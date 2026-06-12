import { describe, expect, it } from "vitest";

import {
  decryptCredentialPayload,
  encryptCredentialPayload,
  maskCredentialPayload,
  type CredentialPayload,
} from "../../worker/security/credentials";

describe("credential payload security", () => {
  const key = "0123456789abcdef0123456789abcdef";
  const payload: CredentialPayload = {
    apiKey: "sk-or-secret-value",
    authCookie: "auth=secret-cookie; theme=light",
    workspaceId: "wrk_123",
  };

  it("encrypts and decrypts credential payloads without retaining plaintext", async () => {
    const encrypted = await encryptCredentialPayload(payload, key);

    expect(encrypted.keyVersion).toBe("v1");
    expect(encrypted.encryptedPayload).not.toContain("sk-or-secret-value");
    expect(encrypted.encryptedPayload).not.toContain("secret-cookie");

    await expect(decryptCredentialPayload(encrypted, key)).resolves.toEqual(payload);
  });

  it("masks secret-like fields while preserving non-secret identifiers", () => {
    expect(maskCredentialPayload(payload)).toEqual({
      apiKey: "sk-or...alue",
      authCookie: "auth=...ight",
      workspaceId: "wrk_123",
    });
  });
});
