// MP3 解码器：优先 WebCodecs 流式解码（低内存、可让出事件循环），
// 不支持时降级为 WebAudio decodeAudioData 整文件解码并明确记录 fallback。

function webCodecsAvailable() {
  return typeof self !== 'undefined' && 'AudioDecoder' in self &&
    typeof self.AudioDecoder === 'function' && self.AudioDecoder.isConfigSupported;
}

async function supportsMp3(sampleRate, channels) {
  if (!webCodecsAvailable()) return false;
  try {
    // isConfigSupported 要求完整配置，缺 sampleRate/numberOfChannels 会直接抛 TypeError
    const r = await self.AudioDecoder.isConfigSupported({
      codec: 'mp3', sampleRate, numberOfChannels: channels,
    });
    return !!(r && r.supported);
  } catch { return false; }
}

/**
 * 按帧索引流式解码 MP3
 * @param frameIndex 容器解析得到的抽样/完整帧偏移
 */
export async function decodeMp3Stream(file, container, onMono, onProgress) {
  const useWebCodecs = await supportsMp3(container.sampleRate, container.channels);
  if (!useWebCodecs) {
    const fb = await decodeWithWebAudioMp3(file);
    // 分块回调，保持与流式路径相同的下游管线
    const block = 44100 * 2;
    for (let off = 0; off < fb.mono.length; off += block) {
      onMono(fb.mono.subarray(off, Math.min(off + block, fb.mono.length)));
      onProgress?.(Math.min(1, off / fb.mono.length));
    }
    onProgress?.(1);
    return { sampleRate: fb.sampleRate, channels: fb.channels, decodedSamples: fb.mono.length, fallback: 'web-audio' };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // 按容器解析出的帧偏移表逐帧喂入。frameIndex 在帧数 ≤2 万时是完整表（步长 1），
  // 偏移与帧长已经过同步字/码率表校验，比临时重扫更可靠，避免 flush 挂起或解出 0 帧。
  const frameIndex = ensureFullFrameIndex(container, bytes);

  return new Promise((resolve, reject) => {
    let outputFrames = 0, outputSamples = 0;
    const decoder = new self.AudioDecoder({
      output: frame => {
        try {
          const nf = frame.numberOfFrames;
          if (frame.numberOfChannels > 1) {
            const p1 = new Float32Array(nf);
            const p2 = new Float32Array(nf);
            frame.copyTo(p1, { planeIndex: 0, frameOffset: 0, frameCount: nf });
            frame.copyTo(p2, { planeIndex: 1, frameOffset: 0, frameCount: nf });
            const mono = new Float64Array(nf);
            for (let i = 0; i < nf; i++) mono[i] = (p1[i] + p2[i]) / 2;
            onMono(mono);
          } else {
            const p1 = new Float32Array(nf);
            frame.copyTo(p1, { planeIndex: 0, frameOffset: 0, frameCount: nf });
            onMono(Float64Array.from(p1));
          }
          outputFrames++; outputSamples += nf;
          frame.close();
        } catch (e) { reject(e); }
      },
      error: e => reject(new Error('WebCodecs 解码错误：' + (e.message || e))),
    });
    decoder.configure({ codec: 'mp3', sampleRate: container.sampleRate, numberOfChannels: container.channels });

    let fed = 0;
    const samplesPerFrame = container.sampleRate <= 24000 ? 576 : 1152;
    for (const fr of frameIndex) {
      decoder.decode(new self.EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round((fed * samplesPerFrame / container.sampleRate) * 1e6),
        data: bytes.subarray(fr.offset, fr.offset + fr.bytes),
      }));
      fed++;
      if (fed % 32 === 0) onProgress?.(fed / frameIndex.length);
    }

    decoder.flush().then(() => {
      decoder.close();
      onProgress?.(1);
      resolve({
        sampleRate: container.sampleRate, channels: container.channels,
        decodedFrames: outputFrames, decodedSamples: outputSamples,
        fedChunks: fed, fallback: 'webcodecs',
      });
    }).catch(reject);
  });
}

// 容器在帧数很大时会抽样 frameIndex；解码需要完整表，按相同规则原地重扫补全。
function ensureFullFrameIndex(container, bytes) {
  if (container.frameCount <= 20000 && container.frameIndex.length === container.frameCount) {
    return container.frameIndex;
  }
  const bitrateTable = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    0: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  };
  const srTable = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const end = container.id3v1 ? container.id3v1.offset : bytes.length;
  const out = [];
  let p = container.firstFrameOffset;
  while (p >= 0 && p + 4 <= end) {
    if ((bytes[p] & 0xff) !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) { p++; continue; }
    const versionId = (bytes[p + 1] >> 3) & 0x3;
    const layerId = (bytes[p + 1] >> 1) & 0x3;
    const bitrateIdx = (bytes[p + 2] >> 4) & 0xf;
    const srIdx = (bytes[p + 2] >> 2) & 0x3;
    const padding = (bytes[p + 2] >> 1) & 0x1;
    const table = bitrateTable[versionId];
    const sr = srTable[versionId]?.[srIdx];
    if (layerId !== 1 || !table || !sr || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) { p++; continue; }
    const bitrate = table[bitrateIdx];
    const frameLen = Math.floor((versionId === 3 ? 144 : 72) * bitrate * 1000 / sr) + padding;
    if (p + frameLen > end) break;
    out.push({ offset: p, bitrate, sampleRate: sr, bytes: frameLen });
    p += frameLen;
  }
  return out;
}

async function decodeWithWebAudioMp3(file) {
  const Ctx = globalThis.AudioContext || (globalThis.webkitAudioContext && globalThis.webkitAudioContext.bind(globalThis));
  if (typeof Ctx !== 'function') {
    throw new Error('当前浏览器既不支持 WebCodecs MP3 解码，也无可用 AudioContext，无法解码该 MP3');
  }
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = buf.length;
    const mono = new Float64Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    for (let i = 0; i < n; i++) mono[i] /= buf.numberOfChannels;
    return { sampleRate: buf.sampleRate, channels: buf.numberOfChannels, mono };
  } finally {
    ctx.close();
  }
}
