// 浏览器端状态层：证据导入、Worker 分析任务、保管链追加与校验，全部落 IndexedDB。
import { STORES, idbPut, idbGet, idbGetAll, idbDelete } from './storage.js';
import { createEntry, verifyChain, CUSTODY_ACTIONS } from './custody.js';
import { Sha256 } from './sha256.js';
import { detectContainer } from '../containers/mp3.js';
import { computeAnalysisHash, buildReport, reportHash } from './report.js';
import { CONTAINER_FORMAT } from './constants.js';

const listeners = new Set();
let cache = { evidence: null, chains: new Map(), analyses: null };

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) try { fn(); } catch { /* ignore */ } }

export async function listEvidence() {
  if (!cache.evidence) cache.evidence = await idbGetAll(STORES.evidence);
  return cache.evidence.sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}

export async function getEvidence(id) {
  return (await listEvidence()).find(e => e.evidenceId === id) || idbGet(STORES.evidence, id);
}

export async function getChain(evidenceId) {
  if (!cache.chains.has(evidenceId)) {
    const rec = await idbGet(STORES.chains, evidenceId);
    cache.chains.set(evidenceId, rec ? rec.entries : []);
  }
  return cache.chains.get(evidenceId);
}

export async function listAnalyses(evidenceId) {
  if (!cache.analyses) cache.analyses = await idbGetAll(STORES.analyses);
  return cache.analyses
    .filter(a => a.evidenceId === evidenceId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getLatestAnalysis(evidenceId) {
  return (await listAnalyses(evidenceId))[0] || null;
}

async function saveChain(evidenceId, entries) {
  cache.chains.set(evidenceId, entries);
  await idbPut(STORES.chains, { evidenceId, entries });
}

export async function appendCustody(evidenceId, action, fields = {}) {
  const entries = await getChain(evidenceId);
  const entry = createEntry(entries[entries.length - 1] || null, action, {
    timestamp: new Date().toISOString(),
    ...fields,
  });
  entries.push(entry);
  await saveChain(evidenceId, entries);
  emit();
  return entry;
}

export async function verifyCustody(evidenceId) {
  const entries = await getChain(evidenceId);
  return verifyChain(entries);
}

async function hashFileChunked(file) {
  const ctx = new Sha256();
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < file.size; off += CHUNK) {
    ctx.update(new Uint8Array(await file.slice(off, Math.min(off + CHUNK, file.size)).arrayBuffer()));
  }
  return ctx.hex();
}

// 仅读首部魔数判断容器，不依赖文件名/扩展名
async function sniffMagic(file) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const fmt = detectContainer(head.buffer);
  return fmt;
}

export async function importEvidence(file, { keepBlob = true } = {}) {
  const fileHash = await hashFileChunked(file);
  const magic = await sniffMagic(file);
  const evidenceId = `EV-${fileHash.slice(0, 16)}`;
  const existing = await idbGet(STORES.evidence, evidenceId);
  if (existing) {
    return { evidence: existing, duplicated: true };
  }
  const evidence = {
    evidenceId,
    fileName: file.name,
    fileSize: file.size,
    fileHash,
    detectedMagic: magic,
    importedAt: new Date().toISOString(),
    blob: keepBlob ? file : null,
  };
  await idbPut(STORES.evidence, evidence);
  cache.evidence = null;
  await saveChain(evidenceId, []);
  await appendCustody(evidenceId, CUSTODY_ACTIONS.IMPORT, {
    evidenceName: file.name,
    fileHash,
    detail: { fileSize: file.size, detectedMagic: magic, importMode: keepBlob ? 'blob-retained' : 'metadata-only' },
  });
  return { evidence, duplicated: false };
}

export async function deleteEvidence(evidenceId) {
  await idbDelete(STORES.evidence, evidenceId);
  await idbDelete(STORES.chains, evidenceId);
  if (cache.analyses) {
    for (const a of cache.analyses.filter(x => x.evidenceId === evidenceId)) {
      await idbDelete(STORES.analyses, a.analysisId);
    }
  }
  cache.evidence = null; cache.analyses = null; cache.chains.delete(evidenceId);
  emit();
}

function workerUrl() {
  return new URL('../workers/analyze-worker.js', import.meta.url);
}

/**
 * 运行分析。Worker 全程本地执行，onProgress 回调驱动 UI。
 * 同一文件重复分析结果一致；每次分析都留保管链记录。
 */
export function runAnalysis(evidence, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl(), { type: 'module' });
    const file = evidence.blob instanceof Blob ? evidence.blob : null;
    if (!file) {
      worker.terminate();
      reject(new Error('证据未保留文件本体（metadata-only），无法复检'));
      return;
    }
    worker.postMessage({ type: 'analyze', file });
    worker.onmessage = async ev => {
      const msg = ev.data;
      if (msg.type === 'progress') { onProgress?.(msg); return; }
      if (msg.type === 'error') { worker.terminate(); reject(new Error(msg.message)); return; }
      if (msg.type === 'done') {
        worker.terminate();
        try {
          const analysisHash = await computeAnalysisHash({
            fileHash: msg.fileHash,
            container: msg.container,
            analysisResult: msg.analysisResult,
          });
          const record = {
            analysisId: `AN-${analysisHash.slice(0, 16)}`,
            evidenceId: evidence.evidenceId,
            createdAt: new Date().toISOString(),
            analysisHash,
            fileHash: msg.fileHash,
            container: msg.container,
            decodeInfo: msg.decodeInfo,
            featureMeta: msg.featureMeta,
            analysisResult: msg.analysisResult,
            waveform: msg.waveform,
          };
          await idbPut(STORES.analyses, record);
          cache.analyses = null;
          await appendCustody(evidence.evidenceId, CUSTODY_ACTIONS.ANALYZE, {
            evidenceName: evidence.fileName,
            fileHash: analysisHash,
            detail: {
              analysisId: record.analysisId,
              findings: msg.analysisResult.stats,
              decoder: msg.decodeInfo.decoder,
            },
          });
          resolve(record);
        } catch (e) { reject(e); }
      }
    };
    worker.onerror = e => { worker.terminate(); reject(e); };
  });
}

export async function buildEvidenceReport(evidence, analysis) {
  const chain = await getChain(evidence.evidenceId);
  return buildReport({
    evidence,
    container: analysis.container,
    decodeInfo: analysis.decodeInfo,
    featureMeta: analysis.featureMeta,
    analysisResult: analysis.analysisResult,
    analysisHash: analysis.analysisHash,
    custodyEntries: chain,
    generatedAt: new Date().toISOString(),
  });
}

export async function recordExport(evidenceId, action, fileName, hash, detail = {}) {
  await appendCustody(evidenceId, action, {
    fileHash: hash,
    detail: { exportedFile: fileName, ...detail },
  });
}

export { reportHash, CUSTODY_ACTIONS, CONTAINER_FORMAT };
