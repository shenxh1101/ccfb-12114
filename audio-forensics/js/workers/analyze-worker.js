// 分析 Worker：容器解析 → 分块解码/重采样 → 环形缓冲特征提取 → 检测。
// 数小时录音按块流过，内存占用与块大小相关而非录音总时长。
import { parseWavContainer } from '../containers/wav.js';
import { parseMp3Container, detectContainer } from '../containers/mp3.js';
import { CONTAINER_FORMAT, ANALYSIS_PARAMS } from '../core/constants.js';
import { decodeWavStream, canStreamDecodeWav, decodeWithWebAudio } from '../decoders/wav-decoder.js';
import { decodeMp3Stream } from '../decoders/mp3-decoder.js';
import { resampleLinear, downmixToMono } from '../dsp/resample.js';
import { extractFeatures } from '../dsp/features.js';
import { analyze } from '../core/detection.js';
import { Sha256 } from '../core/sha256.js';

const P = ANALYSIS_PARAMS;
const TARGET_SR = P.sampleRateTarget;

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

// 环形流式信号缓冲：保留重叠区以支撑帧提取，旧样本及时丢弃
class StreamingSignal {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.overlap = P.frameSize - P.hopSize;
    this.parts = [];
    this.totalSamples = 0;
    this.consumed = 0; // 已被帧消费的样本数（绝对坐标）
  }

  append(monoChunk) {
    // 统一到目标采样率
    const rs = this.sampleRate === TARGET_SR
      ? monoChunk
      : resampleLinear(monoChunk, this.sampleRate, TARGET_SR);
    this.parts.push(rs instanceof Float64Array ? rs : Float64Array.from(rs));
    this.totalSamples += rs.length;
  }

  // 拼接当前全部块（仅保留未消费区域 + 重叠），返回连续 Float64Array
  flatten() {
    const keepFrom = Math.max(0, this.consumed - this.overlap);
    let total = 0;
    for (const p of this.parts) total += p.length;
    const startAbs = this.totalSamples - total; // parts[0] 起点的绝对坐标
    const skip = keepFrom - startAbs;
    const out = new Float64Array(total - Math.max(0, skip));
    let off = 0;
    let acc = 0;
    for (const p of this.parts) {
      const localSkip = Math.max(0, skip - acc);
      const take = p.length - localSkip;
      if (take > 0) out.set(p.subarray(localSkip), off), off += take;
      acc += p.length;
    }
    return { signal: out.subarray(0, off), baseAbs: keepFrom };
  }

  markConsumed(samples) {
    this.consumed += samples;
    // 释放完全越过重叠区的块
    const retainBefore = this.consumed - this.overlap;
    let absStart = this.totalSamples - this.parts.reduce((s, p) => s + p.length, 0);
    while (this.parts.length > 1 && absStart + this.parts[0].length <= retainBefore) {
      absStart += this.parts[0].length;
      this.parts.shift();
    }
  }
}

async function hashFile(file) {
  const ctx = new Sha256();
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = new Uint8Array(await file.slice(off, Math.min(off + CHUNK, file.size)).arrayBuffer());
    ctx.update(buf);
    post('progress', { stage: 'hash', ratio: off / file.size, message: '计算文件哈希' });
  }
  return ctx.hex();
}

async function run(message) {
  const { file } = message;
  post('progress', { stage: 'start', ratio: 0, message: '读取容器结构' });

  const fileBuffer = await file.arrayBuffer();
  const format = detectContainer(fileBuffer);
  let container, decodeInfo;

  if (format === CONTAINER_FORMAT.WAV) {
    container = parseWavContainer(fileBuffer);
    const info = container.audio || {};
    if (canStreamDecodeWav(info)) {
      const stream = new StreamingSignal(info.sampleRate);
      let total = 0;
      await decodeWavStream(file, info, chunk => {
        stream.append(chunk);
        total += chunk.length;
      }, r => post('progress', { stage: 'decode', ratio: r * 0.45, message: '流式解码 WAV' }));
      decodeInfo = {
        decoder: 'wav-pcm-stream',
        sampleRate: info.sampleRate, channels: info.channels, fallback: null,
        sourceSamples: total,
      };
      return finish(stream, container, decodeInfo, file, message);
    }
    // 压缩 WAV 兜底
    const fb = await decodeWithWebAudio(file);
    container = container;
    const stream = new StreamingSignal(fb.sampleRate);
    stream.append(fb.mono);
    decodeInfo = {
      decoder: 'web-audio-fallback', sampleRate: fb.sampleRate,
      channels: fb.channels, fallback: 'web-audio', sourceSamples: fb.mono.length,
    };
    return finish(stream, container, decodeInfo, file, message);
  }

  if (format === CONTAINER_FORMAT.MP3) {
    container = parseMp3Container(fileBuffer);
    const stream = new StreamingSignal(container.sampleRate);
    let total = 0;
    const result = await decodeMp3Stream(file, container, chunk => {
      stream.append(chunk);
      total += chunk.length;
    }, r => post('progress', { stage: 'decode', ratio: r * 0.45, message: '流式解码 MP3' }));
    decodeInfo = {
      decoder: result.fallback === 'web-audio' ? 'web-audio-fallback' : 'webcodecs-mp3-stream',
      sampleRate: result.sampleRate, channels: result.channels,
      fallback: result.fallback === 'web-audio' ? 'web-audio' : null,
      sourceSamples: total,
    };
    return finish(stream, container, decodeInfo, file, message);
  }

  throw new Error('魔数无法识别为 WAV(RIFF) 或 MP3(MPEG Layer III)，已拒绝按文件名猜测格式');
}

// 特征提取：对环形缓冲做分块帧扫描，累计帧特征，控制内存
async function finish(stream, container, decodeInfo, file, message) {
  post('progress', { stage: 'features', ratio: 0.46, message: '提取声学特征' });
  const { signal, baseAbs } = stream.flatten();
  // 让事件循环有机会处理取消/刷新
  await new Promise(r => setTimeout(r, 0));

  const feat = extractFeatures(signal, TARGET_SR, P, ratio => {
    post('progress', { stage: 'features', ratio: 0.46 + ratio * 0.4, message: '提取声学特征' });
  });
  // 时间戳基于目标采样率绝对坐标，修正环形缓冲裁剪造成的偏移
  const offsetSec = baseAbs / TARGET_SR;
  for (let i = 0; i < feat.times.length; i++) feat.times[i] += offsetSec;

  post('progress', { stage: 'detect', ratio: 0.88, message: '多线索篡改检测' });
  await new Promise(r => setTimeout(r, 0));
  const analysisResult = analyze(feat, container);

  // 时间线峰值包络降采样到 ≤1600 点，降低传输/绘图内存
  const peakEnv = downsampleEnvelope(feat.peakEnv, 1600);
  const featureMeta = {
    analysisFrames: feat.frames,
    frameRate: Math.round(feat.frameRate * 1000) / 1000,
    frameDurationSec: Math.round((1 / feat.frameRate) * 100000) / 100000,
    durationSec: Math.round(feat.times[feat.frames - 1] * 1000) / 1000 || 0,
    analysisSampleRate: TARGET_SR,
    waveform: { points: peakEnv.length, minDb: -60 },
  };

  post('progress', { stage: 'hash', ratio: 0.95, message: '复算文件哈希' });
  const fileHash = await hashFile(file);

  post('done', {
    container, decodeInfo, featureMeta, analysisResult, fileHash,
    waveform: { peakEnv, durationSec: featureMeta.durationSec },
  });
}

function downsampleEnvelope(env, maxPoints) {
  if (env.length <= maxPoints) return Float32Array.from(env);
  const step = env.length / maxPoints;
  const out = new Float32Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    const lo = Math.floor(i * step), hi = Math.max(lo + 1, Math.floor((i + 1) * step));
    let m = 0;
    for (let j = lo; j < hi; j++) m = Math.max(m, env[j]);
    out[i] = m;
  }
  return out;
}

self.onmessage = async ev => {
  const msg = ev.data;
  if (msg.type === 'analyze') {
    try {
      await run(msg);
    } catch (err) {
      post('error', { message: err.message, stack: String(err.stack || '') });
    }
  }
};
