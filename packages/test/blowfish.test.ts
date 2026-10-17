import { describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { Blowfish, BLOWFISH_IV } from "../src/core/blowfish";

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bunCipher(key: Uint8Array, iv: Uint8Array, data: Uint8Array, mode: "encrypt" | "decrypt"): Uint8Array | null {
  try {
    const factory = mode === "encrypt" ? createCipheriv : createDecipheriv;
    const cipher = factory("bf-cbc", key, iv);
    return Uint8Array.from(Buffer.concat([cipher.update(data), cipher.final()]));
  } catch {
    return null;
  }
}

describe("Blowfish", () => {
  // Standard Blowfish test vectors (Eric Young / Schneier).
  test.each([
    ["0000000000000000", "0000000000000000", "4ef997456198dd78"],
    ["ffffffffffffffff", "ffffffffffffffff", "51866fd5b85ecb8a"],
    ["3000000000000000", "1000000000000001", "7d856f9a613063f2"],
    ["1111111111111111", "1111111111111111", "2466dd878b963c9d"],
  ])("encrypts key=%s block=%s", (keyHex, blockHex, cipherHex) => {
    const blowfish = new Blowfish(fromHex(keyHex));
    const block = fromHex(blockHex);
    const left = ((block[0]! << 24) | (block[1]! << 16) | (block[2]! << 8) | block[3]!) | 0;
    const right = ((block[4]! << 24) | (block[5]! << 16) | (block[6]! << 8) | block[7]!) | 0;
    const [encryptedLeft, encryptedRight] = blowfish.encryptBlock(left, right);
    const [decryptedLeft, decryptedRight] = blowfish.decryptBlock(encryptedLeft, encryptedRight);
    expect(encryptedLeft >>> 0).toBe(Number.parseInt(cipherHex.slice(0, 8), 16));
    expect(encryptedRight >>> 0).toBe(Number.parseInt(cipherHex.slice(8), 16));
    expect(decryptedLeft >>> 0).toBe(left >>> 0);
    expect(decryptedRight >>> 0).toBe(right >>> 0);
  });

  test("cbc encrypt/decrypt round trip", () => {
    const key = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 3) & 0xff);
    const iv = BLOWFISH_IV;
    const data = Uint8Array.from({ length: 2048 * 3 + 512 }, (_, i) => (i * 31 + 17) & 0xff);
    const blowfish = new Blowfish(key);
    const encrypted = new Uint8Array(data.length);
    blowfish.encryptCbc(data, 0, data.length, encrypted, iv);
    expect(toHex(encrypted)).not.toBe(toHex(data));
    const decrypted = new Uint8Array(data.length);
    blowfish.decryptCbc(encrypted, 0, encrypted.length, decrypted, iv);
    expect(toHex(decrypted)).toBe(toHex(data));
  });

  test("matches the runtime bf-cbc implementation when available", () => {
    const key = Uint8Array.from({ length: 16 }, (_, i) => (i * 13 + 5) & 0xff);
    const data = Uint8Array.from({ length: 1024 }, (_, i) => (i * 3 + 11) & 0xff);
    const reference = bunCipher(key, BLOWFISH_IV, data, "encrypt");
    if (!reference) {
      // Node.js with OpenSSL 3: bf-cbc lives in the legacy provider.
      return;
    }
    const blowfish = new Blowfish(key);
    const ours = new Uint8Array(data.length);
    blowfish.encryptCbc(data, 0, data.length, ours, BLOWFISH_IV);
    expect(toHex(ours)).toBe(toHex(reference.subarray(0, data.length)));

    // And our decryption must decrypt what the runtime produced.
    const decrypted = new Uint8Array(data.length);
    blowfish.decryptCbc(reference, 0, data.length, decrypted, BLOWFISH_IV);
    expect(toHex(decrypted)).toBe(toHex(data));
  });

  test("decrypts a Deezer BF_CBC_STRIPE payload", () => {
    // Deezer encrypts chunk 0, 3, 6, … of a 2048-byte striped file.
    const key = fromHex("0123456789abcdef0123456789abcdef");
    const plain = Uint8Array.from({ length: 2048 * 5 + 137 }, (_, i) => (i * 97 + 13) & 0xff);
    const striper = new Blowfish(key);
    const payload = plain.slice();
    const chunkCount = Math.ceil(payload.length / 2048);
    for (let index = 0; index < chunkCount; index++) {
      if (index % 3 !== 0) continue;
      const offset = index * 2048;
      const length = Math.min(2048, payload.length - offset);
      if (length < 2048) continue;
      // In-place CBC encryption is safe: every block is read before it is written.
      striper.encryptCbc(payload, offset, 2048, payload, BLOWFISH_IV);
    }
    expect(toHex(payload)).not.toBe(toHex(plain));

    const decryptor = new Blowfish(key);
    const out = new Uint8Array(payload.length);
    for (let index = 0; index < chunkCount; index++) {
      const offset = index * 2048;
      const length = Math.min(2048, payload.length - offset);
      if (index % 3 === 0 && length === 2048) {
        decryptor.decryptCbc(payload, offset, 2048, out, BLOWFISH_IV);
      } else {
        out.set(payload.subarray(offset, offset + length), offset);
      }
    }
    expect(toHex(out)).toBe(toHex(plain));
  });
});
