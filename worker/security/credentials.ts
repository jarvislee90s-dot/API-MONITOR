export type CredentialPayload = Record<string, string | number | boolean | null>;

export type EncryptedCredentialPayload = {
  encryptedPayload: string;
  nonce: string;
  keyVersion: "v1";
};

const keyVersion = "v1";
const nonceByteLength = 12;
const secretKeyPattern = /apiKey|cookie|token|secret|password/i;

export async function encryptCredentialPayload(
  payload: CredentialPayload,
  rawKey: string,
): Promise<EncryptedCredentialPayload> {
  const key = await importAesGcmKey(rawKey);
  const nonce = crypto.getRandomValues(new Uint8Array(nonceByteLength));
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, encodedPayload);

  return {
    encryptedPayload: bytesToBase64(new Uint8Array(encrypted)),
    nonce: bytesToBase64(nonce),
    keyVersion,
  };
}

export async function decryptCredentialPayload(
  encrypted: EncryptedCredentialPayload,
  rawKey: string,
): Promise<CredentialPayload> {
  const key = await importAesGcmKey(rawKey);
  const nonce = base64ToBytes(encrypted.nonce);
  const payloadBytes = base64ToBytes(encrypted.encryptedPayload);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce.buffer as ArrayBuffer },
    key,
    payloadBytes.buffer as ArrayBuffer,
  );
  const payload = JSON.parse(new TextDecoder().decode(decrypted));

  return payload as CredentialPayload;
}

export function maskCredentialPayload(payload: CredentialPayload): CredentialPayload {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (typeof value === "string" && secretKeyPattern.test(key)) {
        return [key, maskSecretValue(value)];
      }

      return [key, value];
    }),
  );
}

async function importAesGcmKey(rawKey: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(rawKey);

  if (keyBytes.byteLength !== 32) {
    throw new Error("Credential encryption key must be 32 UTF-8 bytes.");
  }

  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function maskSecretValue(value: string): string {
  if (value.length <= 8) {
    return "••••";
  }

  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
