// 纯函数工具：哈希、字节格式化、鲁棒统计。不依赖 DOM，可在 Node 下直接测试。

export function bytesToHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    const h = view[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}

export async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(buf);
}

// 对 ArrayBuffer / Uint8Array 分块哈希，避免数小时录音一次性占内存
export async function sha256Chunked(streamChunks) {
  const enc = new TextEncoder();
  // Web Crypto 不支持流式，使用分块更新的 JS SHA-256 实现（见 sha256.js）
  const { Sha256 } = await import('./sha256.js');
  const ctx = new Sha256();
  for await (const chunk of streamChunks) {
    ctx.update(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  return ctx.hex();
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '--:--.---';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (x, w = 2) => String(x).padStart(w, '0');
  const base = h > 0
    ? `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
    : `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  return neg ? '-' + base : base;
}

// 确定性 JSON：键按字典序排列，无多余空白，用于哈希与复算
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

// 中位数（输入会被复制，不改动原数组）
export function median(arr) {
  const a = Array.from(arr).sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

// 鲁棒 z 分数序列：以滑动窗口中位数与 MAD 为基线
// 返回与输入等长的数组；MAD 为 0 的平台区返回 0（无异常）。
export function robustZScore(values, radius) {
  const n = values.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius), hi = Math.min(n, i + radius + 1);
    const win = values.subarray ? values.subarray(lo, hi) : values.slice(lo, hi);
    const med = median(win);
    let madSum = 0;
    for (let j = lo; j < hi; j++) madSum += Math.abs(values[j] - med);
    const mad = madSum / (hi - lo);
    out[i] = mad > 1e-12 ? (values[i] - med) / (1.4826 * mad) : 0;
  }
  return out;
}

// 一阶差分（首元素补 0）
export function diff(arr) {
  const out = new Float64Array(arr.length);
  for (let i = 1; i < arr.length; i++) out[i] = arr[i] - arr[i - 1];
  return out;
}

// 变异系数
export function coefficientOfVariation(arr) {
  const m = mean(arr);
  if (Math.abs(m) < 1e-12) return 0;
  let v = 0;
  for (const x of arr) v += (x - m) * (x - m);
  return Math.sqrt(v / arr.length) / Math.abs(m);
}

export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
