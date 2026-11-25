// Node 自动化测试（node --test），不依赖浏览器环境。
// 覆盖：SHA-256 正确性、保管链防篡改、容器解析、检测有效性、假阳性区分、可复现性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { Sha256, sha256Bytes } from '../js/core/sha256.js';
import { canonicalJSON } from '../js/core/util.js';
import { createEntry, verifyChain } from '../js/core/custody.js';
import { parseWavContainer } from '../js/containers/wav.js';
import { parseMp3Container, detectContainer } from '../js/containers/mp3.js';
import { extractFeatures } from '../js/dsp/features.js';
import { analyze } from '../js/core/detection.js';
import { ANALYSIS_PARAMS, CONTAINER_FORMAT } from '../js/core/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', 'samples');
const read = name => readFileSync(join(samples, name));
const SR = ANALYSIS_PARAMS.sampleRateTarget;

function readWavMono(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const off = 44, n = (buf.byteLength - 44) / 2;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(off + i * 2, true) / 32768;
  return out;
}

function runDetection(wavFileName) {
  const buf = read(wavFileName);
  const container = parseWavContainer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const signal = readWavMono(buf);
  const feat = extractFeatures(signal, SR, ANALYSIS_PARAMS);
  return { result: analyze(feat, container), feat, container };
}

test('SHA-256 与 Node crypto 结果一致（含分块 update）', () => {
  const data = new TextEncoder().encode('the quick brown fox jumps over the lazy dog'.repeat(999));
  const expect = createHash('sha256').update(data).digest('hex');
  assert.equal(sha256Bytes(data), expect);
  const ctx = new Sha256();
  for (let i = 0; i < data.length; i += 137) ctx.update(data.subarray(i, i + 137));
  assert.equal(ctx.hex(), expect);
  // 空串向量
  assert.equal(sha256Bytes(new Uint8Array(0)), createHash('sha256').digest('hex'));
});

test('保管链：追加链接、校验通过', () => {
  let prev = null; const entries = [];
  for (let i = 0; i < 5; i++) {
    prev = createEntry(prev, i === 0 ? 'import' : 'analyze', {
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      fileHash: 'a'.repeat(64), detail: { i },
    });
    entries.push(prev);
  }
  const ok = verifyChain(entries);
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.equal(entries[0].prevHash, '0'.repeat(64));
  assert.equal(entries[3].prevHash, entries[2].entryHash);
});

test('保管链：修改任意一条 → 定位断裂序号', () => {
  let prev = null; const entries = [];
  for (let i = 0; i < 4; i++) {
    prev = createEntry(prev, 'import', { timestamp: new Date(1_700_000_000_000).toISOString(), fileHash: 'b'.repeat(64) });
    entries.push(prev);
  }
  const tampered = entries.map(e => ({ ...e }));
  tampered[2].fileHash = 'c'.repeat(64); // 改字段但 entryHash 不变
  const v = verifyChain(tampered);
  assert.equal(v.ok, false);
  assert.equal(v.firstBrokenSeq, 2);
  assert.match(v.errors[0], /内容哈希不匹配/);
});

test('保管链：删除中间一条 → 断链且序号不连续', () => {
  let prev = null; const entries = [];
  for (let i = 0; i < 4; i++) {
    prev = createEntry(prev, 'import', { timestamp: new Date(1_700_000_000_000).toISOString(), fileHash: 'd'.repeat(64) });
    entries.push(prev);
  }
  const removed = entries.filter((_, i) => i !== 1);
  const v = verifyChain(removed);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => /prevHash/.test(e)));
});

test('canonicalJSON 键序确定且与插入顺序无关', () => {
  const a = canonicalJSON({ z: 1, a: { y: 2, b: 3 } });
  const b = canonicalJSON({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
});

test('容器识别：魔数判断，扩展名无关', () => {
  const wav = read('pristine.wav');
  const mp3 = read('reencoded.mp3');
  assert.equal(detectContainer(wav.buffer.slice(wav.byteOffset)), CONTAINER_FORMAT.WAV);
  assert.equal(detectContainer(mp3.buffer.slice(mp3.byteOffset)), CONTAINER_FORMAT.MP3);
});

test('WAV 容器：解析 fmt/data，自洽字段正确', () => {
  const buf = read('pristine.wav');
  const c = parseWavContainer(buf.buffer.slice(buf.byteOffset));
  assert.equal(c.detectedFormat, CONTAINER_FORMAT.WAV);
  assert.equal(c.audio.sampleRate, 22050);
  assert.equal(c.audio.channels, 1);
  assert.equal(c.audio.bitsPerSample, 16);
  assert.equal(c.anomalies.length, 0);
  assert.ok(c.chunks.some(k => k.id === 'data'));
});

test('WAV 容器：RIFF 长度篡改产生异常', () => {
  const buf = read('tampered-riff.wav');
  const c = parseWavContainer(buf.buffer.slice(buf.byteOffset));
  assert.ok(c.anomalies.some(a => a.code === 'RIFF_SIZE_MISMATCH'));
});

test('MP3 容器：帧遍历、码率与时长、ID3 结构', () => {
  const buf = read('reencoded.mp3');
  const c = parseMp3Container(buf.buffer.slice(buf.byteOffset));
  assert.equal(c.frameCount > 100, true);
  assert.equal(c.sampleRate, 22050);
  assert.ok(c.estimatedDurationSec > 10 && c.estimatedDurationSec < 14);
  assert.equal(c.anomalies.filter(a => a.code === 'GAP_BYTES').length, 0);
});

test('检测有效性：拼接样例在拼接点附近（6s）产生高/中置信疑点', () => {
  const { result } = runDetection('spliced.wav');
  const splices = result.findings.filter(f => f.kind === 'splice');
  assert.ok(splices.length >= 1, '应至少检出 1 个拼接疑点');
  // 本底台阶用 ±1s 长窗估计，检测点为窗口中心，容差与 floorWindowSec 匹配
  const near = splices.find(f => Math.abs(f.timeSec - 6) < 0.75);
  assert.ok(near, '应在 6s ±0.75s 内检出拼接点');
  assert.notEqual(near.confidence, 'low');
  assert.ok(near.cueAgreement >= 1, '拼接点应有线索印证');
  // 最强疑点必须是本底台阶类（主证据）
  const strongest = splices.sort((a, b) => b.score - a.score)[0];
  assert.match(strongest.classification, /splice/);
});

test('假阳性区分：干净样例不得产生高置信拼接', () => {
  const { result } = runDetection('pristine.wav');
  const high = result.findings.filter(f => f.kind === 'splice' && f.confidence === 'high');
  assert.equal(high.length, 0);
});

test('假阳性区分：重采样样例给出全局 resample 解释结论', () => {
  const { result } = runDetection('resampled.wav');
  assert.ok(result.globalFindings.some(f => f.kind === 'resample'),
    '重采样样例应产生全局重采样解释');
});

test('可复现性：同样输入两次分析，疑点列表逐字段一致', () => {
  const a = runDetection('spliced.wav').result;
  const b = runDetection('spliced.wav').result;
  assert.equal(canonicalJSON(a.findings), canonicalJSON(b.findings));
  assert.equal(canonicalJSON(a.stats), canonicalJSON(b.stats));
});

test('可复现性：MP3 拼接样例同样可稳定检出（容器+解码由浏览器完成，此处验证容器层）', () => {
  const buf = read('spliced.mp3');
  const c1 = parseMp3Container(buf.buffer.slice(buf.byteOffset));
  const c2 = parseMp3Container(buf.buffer.slice(buf.byteOffset));
  assert.equal(c1.frameCount, c2.frameCount);
  assert.deepEqual(c1.anomalies.map(a => a.code), c2.anomalies.map(a => a.code));
});
