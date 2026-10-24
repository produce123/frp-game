import { describe, it, expect } from "vitest";
import { encrypt, decrypt, isProductFile } from "../index";

describe("crypto", () => {
  const key = "1234567890abcdef"; // 16 ASCII chars

  it("encrypts and decrypts round-trip", async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const encrypted = await encrypt(original, key);
    expect(isProductFile(encrypted)).toBe(true);
    expect(encrypted.length).toBe(4 + 16 + 32); // magic + IV + AES block
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toEqual(original);
  });

  it("detects non-product files", () => {
    expect(isProductFile(new Uint8Array([0x0a, 0x01, 0x02]))).toBe(false);
    expect(isProductFile(new Uint8Array([0x4d, 0x4d, 0x4d, 0x50]))).toBe(true);
  });

  it("rejects wrong key", async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const encrypted = await encrypt(original, key);
    await expect(decrypt(encrypted, "xxxxxxxxxxxxxxxx")).rejects.toThrow();
  });

  it("rejects non-product data", async () => {
    await expect(decrypt(new Uint8Array([1, 2, 3]), key)).rejects.toThrow("Not a .mmmap file");
  });
});