// 纯 JS SHA-256（FIPS 180-4），支持流式 update，供大文件分块哈希与 Node 测试使用。
// 实现参照标准伪代码，结果与 crypto.subtle / Node crypto 完全一致（由 tests 校验）。
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

export class Sha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.bytesHi = 0;
    this.bytesLo = 0;
    this.w = new Uint32Array(64);
  }

  addLength(len) {
    const lo = this.bytesLo;
    this.bytesLo = (lo + len) >>> 0;
    if (this.bytesLo < lo) this.bytesHi = (this.bytesHi + 1) >>> 0;
    this.bytesHi = (this.bytesHi + Math.floor(len / 0x100000000)) >>> 0;
  }

  update(data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.addLength(u8.length);
    let offset = 0;
    if (this.blockLen > 0) {
      while (offset < u8.length && this.blockLen < 64) {
        this.block[this.blockLen++] = u8[offset++];
      }
      if (this.blockLen === 64) { this.process(this.block, 0); this.blockLen = 0; }
    }
    while (offset + 64 <= u8.length) {
      this.process(u8, offset);
      offset += 64;
    }
    while (offset < u8.length) this.block[this.blockLen++] = u8[offset++];
    return this;
  }

  process(buf, off) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const hh = this.h;
    hh[0] = (hh[0] + a) >>> 0; hh[1] = (hh[1] + b) >>> 0; hh[2] = (hh[2] + c) >>> 0;
    hh[3] = (hh[3] + d) >>> 0; hh[4] = (hh[4] + e) >>> 0; hh[5] = (hh[5] + f) >>> 0;
    hh[6] = (hh[6] + g) >>> 0; hh[7] = (hh[7] + h) >>> 0;
  }

  digest() {
    // 标准填充：0x80 + 零 + 64 位位长；填充块不经过 update，避免长度被重复计数
    const bitLenHi = this.bytesHi;
    const bitLenLo = Math.imul(this.bytesLo, 8) >>> 0;
    const blocks = [];
    const first = new Uint8Array(64);
    first.set(this.block.subarray(0, this.blockLen), 0);
    first[this.blockLen] = 0x80;
    blocks.push(first);
    if (this.blockLen >= 56) {
      blocks.push(new Uint8Array(64)); // 长度字段放不下，再补一个全零块
    }
    const last = blocks[blocks.length - 1];
    new DataView(last.buffer).setUint32(56, bitLenHi);
    new DataView(last.buffer).setUint32(60, bitLenLo);
    for (const b of blocks) this.process(b, 0);
    const out = new Uint8Array(32);
    const v = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) v.setUint32(i * 4, this.h[i]);
    return out;
  }

  hex() {
    const d = this.digest();
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
  }
}

export function sha256Bytes(data) {
  return new Sha256().update(data).hex();
}
