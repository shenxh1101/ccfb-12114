// 基 2 迭代 FFT（Cooley–Tukey），确定性实现，无平台依赖。
export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0 || size < 2) throw new Error('FFT size must be power of 2');
    this.size = size;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.rev = new Uint32Array(size);
    // 位反转排列表
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let x = i, r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size >> 1);
    this.sin = new Float64Array(size >> 1);
    for (let i = 0; i < (size >> 1); i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / size);
      this.sin[i] = Math.sin(-2 * Math.PI * i / size);
    }
  }

  // 输入时域实数信号，输出功率谱（长度 size/2+1）
  powerSpectrum(input) {
    const { size, re, im, rev, cos, sin } = this;
    for (let i = 0; i < size; i++) {
      re[i] = input[rev[i]] || 0;
      im[i] = 0;
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1, step = size / len;
      for (let i = 0; i < size; i += len) {
        let k = 0;
        for (let j = 0; j < half; j++, k += step) {
          const ur = re[i + j], ui = im[i + j];
          const vr = re[i + j + half] * cos[k] - im[i + j + half] * sin[k];
          const vi = re[i + j + half] * sin[k] + im[i + j + half] * cos[k];
          re[i + j] = ur + vr; im[i + j] = ui + vi;
          re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
        }
      }
    }
    const n = (size >> 1) + 1;
    const power = new Float64Array(n);
    for (let i = 0; i < n; i++) power[i] = re[i] * re[i] + im[i] * im[i];
    return power;
  }
}

export function hannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}

// DCT-II（用于 MFCC），确定性实现
export function dctII(input, outCount) {
  const n = input.length;
  const out = new Float64Array(outCount);
  for (let k = 0; k < outCount; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += input[i] * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
    out[k] = s;
  }
  return out;
}
