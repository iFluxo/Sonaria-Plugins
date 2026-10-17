import { BLOWFISH_INIT } from "./blowfish-constants";

/**
 * Fixed initialisation vector used by Deezer's `BF_CBC_STRIPE` obfuscation:
 * the bytes `00 01 02 03 04 05 06 07`.
 */
export const BLOWFISH_IV = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

/**
 * Minimal, dependency-free Blowfish implementation (encrypt + decrypt, raw
 * block and CBC without padding).
 *
 * OpenSSL 3 / Node.js >= 17 disable `bf-cbc` by default, so a pure integer
 * implementation is the only way to stay portable across Node.js and Bun.
 *
 * The key schedule follows the reference algorithm; the P-array and S-boxes
 * are generated from the hexadecimal expansion of pi by
 * `scripts/generate-blowfish-constants.ts`.
 */
export class Blowfish {
  /** Flat schedule: P at `[0..17]`, S0..S3 at `[18..1041]`. */
  readonly #k: Uint32Array;

  constructor(key: Uint8Array) {
    if (key.length === 0) throw new RangeError("Blowfish key must not be empty");
    const k = new Uint32Array(1042);
    k.set(BLOWFISH_INIT);

    let j = 0;
    for (let i = 0; i < 18; i++) {
      let data = 0;
      for (let n = 0; n < 4; n++) {
        data = ((data << 8) | key[j % key.length]!) >>> 0;
        j++;
      }
      k[i] = (k[i]! ^ data) >>> 0;
    }

    let l = 0;
    let r = 0;
    for (let i = 0; i < 18; i += 2) {
      [l, r] = this.#encrypt(l, r, k);
      k[i] = l;
      k[i + 1] = r;
    }
    for (let box = 0; box < 4; box++) {
      const base = 18 + box * 256;
      for (let i = 0; i < 256; i += 2) {
        [l, r] = this.#encrypt(l, r, k);
        k[base + i] = l;
        k[base + i + 1] = r;
      }
    }
    this.#k = k;
  }

  /** The Feistel round function `F`. */
  #f(x: number, k: Uint32Array): number {
    const a = (k[18 + ((x >>> 24) & 0xff)]! + k[274 + ((x >>> 16) & 0xff)]!) | 0;
    return (((a ^ k[530 + ((x >>> 8) & 0xff)]!) | 0) + k[786 + (x & 0xff)]!) | 0;
  }

  #encrypt(l: number, r: number, k = this.#k): [number, number] {
    for (let i = 0; i < 16; i++) {
      l = (l ^ k[i]!) | 0;
      r = (r ^ this.#f(l, k)) | 0;
      const swap = l;
      l = r;
      r = swap;
    }
    const swap = l;
    l = r;
    r = swap;
    r = (r ^ k[16]!) | 0;
    l = (l ^ k[17]!) | 0;
    return [l >>> 0, r >>> 0];
  }

  #decrypt(l: number, r: number): [number, number] {
    const k = this.#k;
    for (let i = 17; i > 1; i--) {
      l = (l ^ k[i]!) | 0;
      r = (r ^ this.#f(l, k)) | 0;
      const swap = l;
      l = r;
      r = swap;
    }
    const swap = l;
    l = r;
    r = swap;
    r = (r ^ k[1]!) | 0;
    l = (l ^ k[0]!) | 0;
    return [l >>> 0, r >>> 0];
  }

  /** Encrypt a single 64 bit block given as two big-endian uint32 halves. */
  encryptBlock(l: number, r: number): [number, number] {
    return this.#encrypt(l, r);
  }

  /** Decrypt a single 64 bit block given as two big-endian uint32 halves. */
  decryptBlock(l: number, r: number): [number, number] {
    return this.#decrypt(l, r);
  }

  /**
   * CBC encrypt `src[off .. off+len)` into `out` at the same offset.
   * `len` must be a multiple of 8.
   */
  encryptCbc(src: Uint8Array, off: number, len: number, out: Uint8Array, iv: Uint8Array = BLOWFISH_IV): void {
    let pl = readUint32(iv, 0);
    let pr = readUint32(iv, 4);
    const end = off + len;
    for (let p = off; p < end; p += 8) {
      const cl = ((src[p]! << 24) | (src[p + 1]! << 16) | (src[p + 2]! << 8) | src[p + 3]!) ^ pl;
      const cr = ((src[p + 4]! << 24) | (src[p + 5]! << 16) | (src[p + 6]! << 8) | src[p + 7]!) ^ pr;
      const [left, right] = this.#encrypt(cl | 0, cr | 0);
      writeUint32(out, p, left);
      writeUint32(out, p + 4, right);
      pl = left;
      pr = right;
    }
  }

  /**
   * CBC decrypt `src[off .. off+len)` into `out` at the same offset, without
   * padding. `len` must be a multiple of 8.
   */
  decryptCbc(src: Uint8Array, off: number, len: number, out: Uint8Array, iv: Uint8Array = BLOWFISH_IV): void {
    let pl = readUint32(iv, 0);
    let pr = readUint32(iv, 4);
    const end = off + len;
    for (let p = off; p < end; p += 8) {
      const cl = (src[p]! << 24) | (src[p + 1]! << 16) | (src[p + 2]! << 8) | src[p + 3]!;
      const cr = (src[p + 4]! << 24) | (src[p + 5]! << 16) | (src[p + 6]! << 8) | src[p + 7]!;
      const [left, right] = this.#decrypt(cl | 0, cr | 0);
      writeUint32(out, p, (left ^ pl) >>> 0);
      writeUint32(out, p + 4, (right ^ pr) >>> 0);
      pl = cl;
      pr = cr;
    }
  }
}

function readUint32(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) | 0;
}

function writeUint32(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 24) & 0xff;
  buf[off + 1] = (value >>> 16) & 0xff;
  buf[off + 2] = (value >>> 8) & 0xff;
  buf[off + 3] = value & 0xff;
}
