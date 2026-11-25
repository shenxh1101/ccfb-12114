// 保管链：哈希链事件日志。每条记录的 entryHash 覆盖前一条 hash，
// 改动、删除、重排任意一条都会让后续全部校验失败，并能定位断裂序号。
import { canonicalJSON } from './util.js';
import { sha256Bytes } from './sha256.js';

// 事件动作词表（报告与界面共用）
export const CUSTODY_ACTIONS = Object.freeze({
  IMPORT: 'import',           // 证据导入
  ANALYZE: 'analyze',         // 完成一次完整性分析
  EXPORT_REPORT: 'export-report', // 导出 JSON 报告
  EXPORT_PDF: 'export-pdf',   // 导出/打印 PDF
  VERIFY: 'verify',           // 手工校验哈希
  EXPORT_EVIDENCE: 'export-evidence', // 导出证据副本
});

const GENESIS = '0'.repeat(64);

// 计算条目哈希：对规范化后的条目内容（不含 entryHash 自身）做 SHA-256
export function computeEntryHash(entry) {
  const { entryHash, ...payload } = entry;
  return sha256Bytes(new TextEncoder().encode(canonicalJSON(payload)));
}

// 追加事件（纯函数，返回新条目）
export function createEntry(prevEntry, action, fields = {}) {
  const seq = prevEntry ? prevEntry.seq + 1 : 0;
  const entry = {
    schemaVersion: 'CHAIN-1.0',
    seq,
    action,
    timestamp: fields.timestamp,          // ISO 字符串，由调用方传入保证可测
    operator: fields.operator || 'local-operator',
    evidenceId: fields.evidenceId || null,
    evidenceName: fields.evidenceName || null,
    fileHash: fields.fileHash || null,    // 当前操作时文件/报告的 SHA-256
    detail: fields.detail || {},
    prevHash: prevEntry ? prevEntry.entryHash : GENESIS,
  };
  entry.entryHash = computeEntryHash(entry);
  return entry;
}

/**
 * 校验整条链
 * @returns {{ok:boolean, firstBrokenSeq:number|null, errors:Array}}
 */
export function verifyChain(entries) {
  const errors = [];
  let prevHash = GENESIS;
  let firstBrokenSeq = null;
  const seenSeq = new Set();

  for (const entry of entries) {
    if (seenSeq.has(entry.seq)) {
      errors.push(`序号 ${entry.seq} 重复，链顺序被破坏`);
      if (firstBrokenSeq === null) firstBrokenSeq = entry.seq;
    }
    seenSeq.add(entry.seq);

    if (entry.prevHash !== prevHash) {
      errors.push(`序号 ${entry.seq} 断链：prevHash 与上一条 entryHash 不一致（记录可能被删除/重排）`);
      if (firstBrokenSeq === null) firstBrokenSeq = entry.seq;
    }
    const expect = computeEntryHash(entry);
    if (expect !== entry.entryHash) {
      errors.push(`序号 ${entry.seq} 内容哈希不匹配：记录字段被篡改（记录值 ${entry.entryHash.slice(0, 12)}…，重算值 ${expect.slice(0, 12)}…）`);
      if (firstBrokenSeq === null) firstBrokenSeq = entry.seq;
    }
    prevHash = entry.entryHash;
  }

  // 序号连续性
  const sorted = entries.map(e => e.seq).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i) {
      errors.push(`序号不连续：期望 ${i}，实际 ${sorted[i]}（存在删除或插入）`);
      if (firstBrokenSeq === null) firstBrokenSeq = sorted[i];
      break;
    }
  }
  return { ok: errors.length === 0, firstBrokenSeq, errors, tip: entries.length ? prevHash : GENESIS };
}

// 链尾指纹：可对外展示的“链头摘要”，任何历史改动都会改变它
export function chainTip(entries) {
  return entries.length ? entries[entries.length - 1].entryHash : GENESIS;
}
