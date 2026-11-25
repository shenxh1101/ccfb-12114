// WAV 解码器：按块从 File/Blob 读取 PCM，数小时录音也不会整体驻留内存。
// 仅支持容器里 fmt 声明的整数 PCM(1) 与 IEEE float(3)；压缩 WAV 交由 WebAudio 兜底。

function readPcmSample(view, byteOffset, bits, formatTag) {
  switch (bits) {
    case 8:  // 8-bit PCM 为无符号
      return (view.getUint8(byteOffset) - 128) / 128;
    case 16:
      return view.getInt16(byteOffset, true) / 32768;
    case 24: {
      const b0 = view.getUint8(byteOffset), b1 = view.getUint8(byteOffset + 1), b2 = view.getUint8(byteOffset + 2);
      let x = (b2 << 16) | (b1 << 8) | b0;
      if (x & 0x800000) x |= 0xff000000;
      return x / 8388608;
    }
    case 32:
      return formatTag === 3 ? view.getFloat32(byteOffset, true) : view.getInt32(byteOffset, true) / 2147483648;
    case 64:
      return formatTag === 3 ? view.getFloat64(byteOffset, true) : 0;
    default:
      throw new Error(`不支持的 PCM 位深: ${bits} bit`);
  }
}

/**
 * 分块解码 WAV
 * @param onMono 每解码一块收到一个 Float64Array（已下混为单声道）
 * @returns {Promise<{sampleRate:number, channels:number, totalSamples:number, decodedSamples:number}>}
 */
export async function decodeWavStream(file, audioInfo, onMono, onProgress) {
  const { sampleRate, channels, bitsPerSample, formatTag, dataOffset, dataLength } = audioInfo;
  const bytesPerSample = bitsPerSample / 8;
  const blockBytes = channels * bytesPerSample;
  const totalSamples = Math.floor(dataLength / blockBytes);
  // 每次约 2 秒音频
  const chunkSeconds = 2;
  const chunkBlocks = sampleRate * chunkSeconds;
  const readBuf = new ArrayBuffer(chunkBlocks * blockBytes + blockBytes);
  let decoded = 0;

  while (decoded < totalSamples) {
    const blocks = Math.min(chunkBlocks, totalSamples - decoded);
    const byteCount = blocks * blockBytes;
    const slice = await file.slice(dataOffset + decoded * blockBytes,
      dataOffset + decoded * blockBytes + byteCount).arrayBuffer();
    const view = new DataView(slice);
    const mono = new Float64Array(blocks);
    for (let i = 0; i < blocks; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) {
        acc += readPcmSample(view, (i * channels + c) * bytesPerSample, bitsPerSample, formatTag);
      }
      mono[i] = acc / channels;
    }
    onMono(mono);
    decoded += blocks;
    if (onProgress) onProgress(decoded / totalSamples);
  }
  return { sampleRate, channels, totalSamples, decodedSamples: decoded };
}

// 判断能否由本模块原生流式解码
export function canStreamDecodeWav(audioInfo) {
  return audioInfo && (audioInfo.formatTag === 1 || audioInfo.formatTag === 3) &&
    [8, 16, 24, 32, 64].includes(audioInfo.bitsPerSample);
}

// 兜底：整体交给 WebAudio decodeAudioData（压缩 WAV 等）
export async function decodeWithWebAudio(file, AudioCtx = self.AudioContext || self.webkitAudioContext) {
  const ctx = new AudioCtx({ sampleRate: ANALYSIS_TARGET() });
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = buf.length;
    const mono = new Float64Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    for (let i = 0; i < n; i++) mono[i] /= buf.numberOfChannels;
    return { sampleRate: buf.sampleRate, channels: buf.numberOfChannels, mono, fallback: true };
  } finally {
    ctx.close();
  }
}

function ANALYSIS_TARGET() {
  // 延迟引入避免循环；WebAudio 重采样目标与分析参数保持一致
  return 22050;
}
