// 逐帧声学特征提取。所有计算使用固定参数与固定 epsilon，保证可复现。
import { FFT, hannWindow, dctII } from './fft.js';
import { ANALYSIS_PARAMS } from '../core/constants.js';

const EPS = 1e-12;

function hzToMel(f) { return 2595 * Math.log10(1 + f / 700); }
function melToHz(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

// 构造梅尔三角滤波器矩阵 [melBands][fftBins]
export function melFilterBank(sampleRate, fftSize, bands, fMin, fMax) {
  const fftBins = (fftSize >> 1) + 1;
  const mels = new Float64Array(bands + 2);
  const binHz = sampleRate / fftSize;
  const mMin = hzToMel(fMin), mMax = hzToMel(Math.min(fMax, sampleRate / 2));
  for (let i = 0; i < bands + 2; i++) mels[i] = melToHz(mMin + (mMax - mMin) * i / (bands + 1)) / binHz;
  const bank = Array.from({ length: bands }, () => new Float64Array(fftBins));
  for (let m = 1; m <= bands; m++) {
    const left = mels[m - 1], center = mels[m], right = mels[m + 1];
    for (let b = Math.max(0, Math.floor(left)); b < Math.min(fftBins, Math.ceil(right)); b++) {
      if (b < center) bank[m - 1][b] = center > left ? (b - left) / (center - left) : 0;
      else bank[m - 1][b] = right > center ? (right - b) / (right - center) : 0;
    }
  }
  return bank;
}

function frameCount(signalLen, frameSize, hop) {
  return Math.max(0, Math.floor((signalLen - frameSize) / hop) + 1);
}

/**
 * 提取全部帧特征
 * @returns {{
 *   frames: number, frameRate: number, times: Float64Array,
 *   rmsDb: Float64Array, zcr: Float64Array, flatness: Float64Array,
 *   centroid: Float64Array, noiseDb: Float64Array,
 *   melLog: Float64Array[], mirrorRatio: Float64Array, mfcc: Float64Array[],
 *   peakEnv: Float32Array
 * }}
 */
export function extractFeatures(signal, sampleRate, params = ANALYSIS_PARAMS, onProgress = null) {
  const { frameSize, hopSize, melBands, fMin, fMax, noiseBandHz, chunkFrames } = params;
  const fft = new FFT(frameSize);
  const window = hannWindow(frameSize);
  const bank = melFilterBank(sampleRate, frameSize, melBands, fMin, fMax);
  const fftBins = (frameSize >> 1) + 1;
  const binHz = sampleRate / frameSize;
  const noiseLo = Math.max(1, Math.round(noiseBandHz[0] / binHz));
  const noiseHi = Math.min(fftBins - 1, Math.round(noiseBandHz[1] / binHz));
  const hfLo = Math.round(params.hfNoiseBandHz[0] / binHz);
  const hfHi = Math.min(fftBins - 1, Math.round(params.hfNoiseBandHz[1] / binHz));

  const n = frameCount(signal.length, frameSize, hopSize);
  const frame = new Float64Array(frameSize);
  const times = new Float64Array(n);
  const rmsDb = new Float64Array(n);
  const zcr = new Float64Array(n);
  const flatness = new Float64Array(n);
  const centroid = new Float64Array(n);
  const noiseDb = new Float64Array(n);
  const hfNoiseDb = new Float64Array(n);
  const fullBandDb = new Float64Array(n);
  const mirrorRatio = new Float64Array(n);
  // 全部预填零，保证任何帧读到的都是有限数值（尾部不足一帧时不会留下 undefined/NaN）
  const melLog = Array.from({ length: n }, () => new Float64Array(melBands));
  const mfcc = Array.from({ length: n }, () => new Float64Array(13));
  const peakEnv = new Float32Array(n);
  const frameRate = sampleRate / hopSize;

  let start = 0;
  while (start < n) {
    const end = Math.min(n, start + chunkFrames);
    for (let f = start; f < end; f++) {
      const base = f * hopSize;
      let energy = 0, zc = 0, prev = 0, peak = 0;
      for (let i = 0; i < frameSize; i++) {
        const s = signal[base + i] * window[i];
        frame[i] = s;
        energy += s * s;
        const x = signal[base + i];
        if (i > 0 && (prev >= 0) !== (x >= 0)) zc++;
        prev = x;
        const ax = Math.abs(x);
        if (ax > peak) peak = ax;
      }
      const power = fft.powerSpectrum(frame);
      times[f] = base / sampleRate;
      rmsDb[f] = 10 * Math.log10(energy / frameSize + EPS);
      zcr[f] = zc / frameSize;
      peakEnv[f] = peak;

      let geo = 0, arith = 0, cent = 0, centW = 0, noiseP = 0, hfP = 0, fullP = 0;
      for (let b = 1; b < fftBins; b++) {
        const p = power[b] + EPS;
        geo += Math.log(p);
        arith += p;
        cent += b * p; centW += p;
        fullP += power[b];
        if (b >= noiseLo && b <= noiseHi) noiseP += p;
        if (b >= hfLo && b <= hfHi) hfP += p;
      }
      flatness[f] = Math.exp(geo / (fftBins - 1)) / (arith / (fftBins - 1) + EPS);
      centroid[f] = (cent / (centW + EPS)) * binHz;
      noiseDb[f] = 10 * Math.log10(noiseP / (noiseHi - noiseLo + 1) + EPS);
      hfNoiseDb[f] = 10 * Math.log10(hfP / (hfHi - hfLo + 1) + EPS);
      fullBandDb[f] = 10 * Math.log10(fullP / (fftBins - 1) + EPS);

      const melE = new Float64Array(melBands);
      for (let m = 0; m < melBands; m++) {
        let e = 0;
        const filt = bank[m];
        for (let b = 0; b < fftBins; b++) e += filt[b] * power[b];
        melE[m] = e;
      }
      // 高频能量占比（保留用于观察，重采样判据改用本底塌缩）
      let hiSum = 0;
      for (let b = Math.round(1000 / binHz); b < fftBins; b++) hiSum += power[b];
      mirrorRatio[f] = hiSum / (fullP + EPS);
      // 梅尔对数能量：浮点误差可能产生极小负值，先钳制到 0；零能量带用 EPS 兜底，避免 log(0)=-InF/NaN
      const logE = new Float64Array(melBands);
      let logMean = 0;
      for (let m = 0; m < melBands; m++) {
        const safe = melE[m] > 0 ? melE[m] : 0;
        logE[m] = Math.log(safe + EPS);
        logMean += logE[m];
      }
      logMean /= melBands;
      const norm = new Float64Array(melBands);
      for (let m = 0; m < melBands; m++) norm[m] = logE[m] - logMean;
      melLog[f].set(norm);
      mfcc[f].set(dctII(norm, 13));
    }
    if (onProgress) onProgress(end / n);
    start = end;
  }

  return {
    frames: n, frameRate, times, rmsDb, zcr, flatness, centroid,
    noiseDb, hfNoiseDb, fullBandDb, melLog, mirrorRatio, mfcc, peakEnv,
    frameSize, hopSize, analysisSampleRate: sampleRate,
  };
}
