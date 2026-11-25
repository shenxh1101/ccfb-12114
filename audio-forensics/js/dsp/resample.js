// 确定性线性插值重采样（不依赖浏览器 AudioContext，保证 Node/浏览器结果一致、可复算）
export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input instanceof Float64Array ? input : Float64Array.from(input);
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0];
    const b = i0 + 1 < input.length ? input[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// 多声道 → 单声道（等权平均），分析阶段使用单声道；原始声道数另存报告
export function downmixToMono(channels) {
  if (channels.length === 1) {
    return channels[0] instanceof Float64Array ? channels[0] : Float64Array.from(channels[0]);
  }
  const n = channels[0].length;
  const out = new Float64Array(n);
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c];
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}
