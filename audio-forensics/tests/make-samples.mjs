#!/usr/bin/env node
// 合成测试样例（仅用于本地测试，不放入证据目录）：
//  - pristine.wav        干净录音：背景噪声 + 两段语音样信号
//  - spliced.wav         在同一时间轴上拼接两段不同噪声基底的音频（模拟剪辑）
//  - resampled.wav       干净录音先降采样再升采样（重采样假阳性对照）
//  - reencoded.mp3       干净录音转 MP3（重编码假阳性对照）
//  - spliced.mp3         拼接后转 MP3
//  - tampered-riff.wav   RIFF 长度被改写的容器异常样例
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'samples');
mkdirSync(outDir, { recursive: true });

const SR = 22050;

// 确定性伪随机（线性同余），保证每次生成的样例字节一致
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 简单二阶滤波给白噪声着色，模拟环境本底噪声
function coloredNoise(n, rand, amp, prev = [0, 0]) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const white = (rand() * 2 - 1) * amp;
    prev[0] = 0.92 * prev[0] + white;
    prev[1] = 0.75 * prev[1] + white * 0.4;
    out[i] = prev[0] + prev[1];
  }
  return out;
}

function speechLike(rand, n, t0, amp = 0.5) {
  const out = new Float64Array(n);
  // 随机“音节”包络 + 基频与谐波，模拟语音节律但完全确定
  let t = 0;
  while (t < n) {
    const syllable = Math.floor(SR * (0.12 + rand() * 0.22));
    const f0 = 90 + rand() * 130;
    for (let i = 0; i < syllable && t + i < n; i++) {
      const env = Math.sin(Math.PI * i / syllable);
      const tt = (t + i) / SR;
      const sig = Math.sin(2 * Math.PI * f0 * tt) + 0.45 * Math.sin(2 * Math.PI * f0 * 2 * tt) + 0.2 * Math.sin(2 * Math.PI * f0 * 3 * tt);
      out[t + i] += sig * env * amp;
    }
    t += syllable + Math.floor(SR * (0.04 + rand() * 0.1));
  }
  return out;
}

function mix(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] || 0) + (b[i] || 0);
  return out;
}

function clip(x) { return Math.max(-1, Math.min(1, x)); }

function buildPristine(seconds = 12, seed = 42) {
  const n = SR * seconds;
  const rand = lcg(seed);
  const noise = coloredNoise(n, rand, 0.012);
  const voice = mix(speechLike(lcg(7), n, 0, 0.42), speechLike(lcg(99), n, 0, 0.3));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = clip(noise[i] + voice[i]);
  return out;
}

// 拼接：0~6s 用低噪声段，6s 处切到另一份高噪声、不同语音内容的段
function buildSpliced(seconds = 12) {
  const half = (SR * seconds) / 2;
  const aRand = lcg(42);
  const aNoise = coloredNoise(half, aRand, 0.012);
  const aVoice = speechLike(lcg(7), half, 0, 0.42);
  const bRand = lcg(7777);
  const bNoise = coloredNoise(half, bRand, 0.045); // 噪声基底台阶
  const bVoice = speechLike(lcg(31337), half, 0, 0.5);
  const out = new Float64Array(SR * seconds);
  for (let i = 0; i < half; i++) {
    out[i] = clip(aNoise[i] + aVoice[i]);
    out[i + half] = clip(bNoise[i] + bVoice[i]);
  }
  return out;
}

function encodeWavPcm16(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(clip(samples[i]) * 32767), true);
  return Buffer.from(buf);
}

const pristine = buildPristine();
const spliced = buildSpliced();
writeFileSync(join(outDir, 'pristine.wav'), encodeWavPcm16(pristine, SR));
writeFileSync(join(outDir, 'spliced.wav'), encodeWavPcm16(spliced, SR));

// 重采样对照：22050 → 8000 → 22050
execSync(`ffmpeg -y -loglevel error -i "${join(outDir, 'pristine.wav')}" -ar 8000 "${join(outDir, '_tmp8k.wav')}"`);
execSync(`ffmpeg -y -loglevel error -i "${join(outDir, '_tmp8k.wav')}" -ar 22050 "${join(outDir, 'resampled.wav')}"`);
// 重编码对照与拼接 MP3
execSync(`ffmpeg -y -loglevel error -i "${join(outDir, 'pristine.wav')}" -codec:a libmp3lame -b:a 128k "${join(outDir, 'reencoded.mp3')}"`);
execSync(`ffmpeg -y -loglevel error -i "${join(outDir, 'spliced.wav')}" -codec:a libmp3lame -b:a 128k "${join(outDir, 'spliced.mp3')}"`);
execSync(`rm -f "${join(outDir, '_tmp8k.wav')}"`);

// 容器异常：篡改 RIFF 声明长度（+100），保留 data 不动
const tampered = Uint8Array.from(encodeWavPcm16(pristine, SR));
const dv = new DataView(tampered.buffer);
dv.setUint32(4, dv.getUint32(4, true) + 100, true);
writeFileSync(join(outDir, 'tampered-riff.wav'), tampered);

console.log('samples written to', outDir);
for (const f of ['pristine.wav', 'spliced.wav', 'resampled.wav', 'reencoded.mp3', 'spliced.mp3', 'tampered-riff.wav']) {
  console.log(' -', f);
}
