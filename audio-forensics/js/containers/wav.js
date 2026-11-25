// WAV/RIFF 容器结构解析：只看魔数与 chunk 结构，不看文件名。
import { CONTAINER_FORMAT } from '../core/constants.js';

const RIFF = 0x52494646; // 'RIFF'
const WAVE = 0x57415645; // 'WAVE'

// WAVE 格式码 → 说明
const FORMAT_TAGS = {
  1: 'PCM 整数', 2: 'MS ADPCM', 3: 'IEEE float', 6: 'A-law', 7: 'μ-law',
  17: 'IMA ADPCM', 49: 'GSM 6.10', 80: 'MPEG Layer III', 85: 'MP3',
  0xfffe: 'WAVE_FORMAT_EXTENSIBLE',
};

export function sniffWav(view) {
  return view.byteLength >= 12 && view.getUint32(0) === RIFF && view.getUint32(8) === WAVE;
}

/**
 * 遍历 RIFF chunk（含 LIST 嵌套），返回结构清单与音频参数。
 * 不做任何解码，只解析容器；data chunk 记录偏移与长度供流式 PCM 读取。
 */
export function parseWavContainer(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const result = {
    detectedFormat: CONTAINER_FORMAT.WAV,
    fileSize: buffer.byteLength,
    riffSize: 0,
    chunks: [],
    anomalies: [],
    audio: null,
    trailerBytes: 0,
  };
  if (!sniffWav(view)) throw new Error('不是 RIFF/WAVE 容器');

  result.riffSize = view.getUint32(4, true);
  if (result.riffSize + 8 !== buffer.byteLength) {
    result.anomalies.push({
      code: 'RIFF_SIZE_MISMATCH',
      message: `RIFF 声明长度 ${result.riffSize + 8} 与实际文件大小 ${buffer.byteLength} 不一致（可能被追加/截断数据）`,
      declared: result.riffSize + 8, actual: buffer.byteLength,
    });
  }

  let offset = 12;
  let fmtSeen = false, dataSeen = false;
  const seenIds = new Map();
  while (offset + 8 <= buffer.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const bodyOff = offset + 8;
    const chunk = { id, size, offset: bodyOff, padding: size % 2 };
    result.chunks.push(chunk);
    seenIds.set(id, (seenIds.get(id) || 0) + 1);

    if (id === 'fmt ') {
      fmtSeen = true;
      if (size < 16) {
        result.anomalies.push({ code: 'FMT_TRUNCATED', message: 'fmt chunk 长度小于 16 字节，结构不完整' });
      } else {
        const tag = view.getUint16(bodyOff, true);
        const channels = view.getUint16(bodyOff + 2, true);
        const sampleRate = view.getUint32(bodyOff + 4, true);
        const byteRate = view.getUint32(bodyOff + 8, true);
        const blockAlign = view.getUint16(bodyOff + 12, true);
        const bitsPerSample = view.getUint16(bodyOff + 14, true);
        result.audio = {
          formatTag: tag, formatName: FORMAT_TAGS[tag] || `未知(0x${tag.toString(16)})`,
          channels, sampleRate, byteRate, blockAlign, bitsPerSample,
          extension: tag === 0xfffe && size >= 40 ? parseExtensible(view, bodyOff) : null,
        };
        // 自洽性校验：blockAlign 与 byteRate 必须与声明参数吻合
        if (tag === 1 || tag === 3) {
          const expectAlign = channels * bitsPerSample / 8;
          if (blockAlign !== expectAlign) {
            result.anomalies.push({
              code: 'BLOCK_ALIGN_MISMATCH',
              message: `blockAlign=${blockAlign} 与声道/位深推算值 ${expectAlign} 不符，fmt 可能被改写`,
            });
          }
          if (byteRate !== sampleRate * blockAlign) {
            result.anomalies.push({
              code: 'BYTE_RATE_MISMATCH',
              message: `byteRate=${byteRate} 与 sampleRate×blockAlign=${sampleRate * blockAlign} 不符`,
            });
          }
        }
      }
    } else if (id === 'data') {
      dataSeen = true;
      result.audio = result.audio || {};
      result.audio.dataOffset = bodyOff;
      result.audio.dataLength = size;
    } else if (id === 'LIST') {
      chunk.children = scanList(bytes, bodyOff, Math.min(size, buffer.byteLength - bodyOff));
    }

    offset = bodyOff + size + (size % 2);
    if (offset > buffer.byteLength) {
      result.anomalies.push({ code: 'CHUNK_OVERFLOW', message: `chunk '${id}' 声明长度越过文件末尾，容器被截断` });
      offset = buffer.byteLength;
      break;
    }
  }

  if (!fmtSeen) result.anomalies.push({ code: 'NO_FMT', message: '缺少 fmt chunk，无法确认音频参数' });
  if (!dataSeen) result.anomalies.push({ code: 'NO_DATA', message: '缺少 data chunk' });
  for (const [id, count] of seenIds) {
    if (count > 1 && (id === 'fmt ' || id === 'data')) {
      result.anomalies.push({ code: 'DUPLICATE_CHUNK', message: `出现 ${count} 个 '${id}' chunk，正常录制文件通常只有一个，存在重封装嫌疑` });
    }
  }
  if (offset < buffer.byteLength) {
    result.trailerBytes = buffer.byteLength - offset;
    result.anomalies.push({
      code: 'TRAILER_BYTES',
      message: `RIFF 结构结束后仍有 ${buffer.byteLength - offset} 字节尾随数据（常见于二次拼接/封装工具残留）`,
      trailerBytes: buffer.byteLength - offset,
    });
  }
  return result;
}

function parseExtensible(view, off) {
  const validBits = view.getUint16(off + 18, true);
  const channelMask = view.getUint32(off + 20, true);
  const subTag = view.getUint16(off + 24, true);
  return { validBitsPerSample: validBits, channelMask, subFormatTag: subTag, subFormatName: FORMAT_TAGS[subTag] || `未知(0x${subTag.toString(16)})` };
}

function scanList(bytes, off, size) {
  const end = off + size;
  const out = [];
  if (size < 4) return out;
  out.push({ type: String.fromCharCode(...bytes.subarray(off, off + 4)) });
  let p = off + 4;
  while (p + 8 <= end) {
    const id = String.fromCharCode(...bytes.subarray(p, p + 4));
    const sz = new DataView(bytes.buffer, bytes.byteOffset + p + 4, 4).getUint32(0, true);
    out.push({ id, size: sz });
    p += 8 + sz + (sz % 2);
  }
  return out;
}
