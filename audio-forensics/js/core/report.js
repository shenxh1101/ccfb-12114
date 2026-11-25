// 报告：JSON 为完整权威记录，PDF 仅为打印视图。报告内容规范化哈希，保证可复算验证。
import { ANALYSIS_PARAMS } from './constants.js';
import { canonicalJSON, sha256Hex } from './util.js';
import { chainTip } from './custody.js';

// 分析指纹：覆盖文件哈希、容器结构、分析参数与全部检测结果。
// 同一份录音 + 同样参数必然产生相同指纹；任何一个疑点变化都会改变指纹。
export async function computeAnalysisHash({ fileHash, container, analysisResult, params }) {
  const payload = {
    fileHash,
    container: stripVolatile(container),
    params,
    findings: analysisResult.findings,
    globalFindings: analysisResult.globalFindings,
  };
  return sha256Hex(new TextEncoder().encode(canonicalJSON(payload)));
}

// 去掉与检测结论无关的易变运行时字段（如抽样帧索引里的大数组单独保留结构摘要）
function stripVolatile(container) {
  const c = JSON.parse(JSON.stringify(container));
  if (c.frameIndex) {
    c.frameIndexSampleCount = c.frameIndex.length;
    c.frameIndexFirst = c.frameIndex[0] || null;
    c.frameIndexLast = c.frameIndex[c.frameIndex.length - 1] || null;
    delete c.frameIndex;
  }
  return c;
}

export function buildReport({
  evidence, container, decodeInfo, featureMeta, analysisResult,
  analysisHash, custodyEntries, generatedAt, toolVersion = ANALYSIS_PARAMS.specVersion,
}) {
  const report = {
    reportSchema: 'AF-REPORT-1.0',
    generatedAt,
    tool: {
      name: '音频完整性校验台（Audio Forensics Workbench）',
      version: toolVersion,
      mode: 'fully-local',
      networkCalls: 0,
    },
    evidence: {
      evidenceId: evidence.evidenceId,
      originalFileName: evidence.fileName,
      fileSizeBytes: evidence.fileSize,
      fileSha256: evidence.fileHash,
      importedAt: evidence.importedAt,
    },
    container: stripVolatile(container),
    decoding: {
      decoder: decodeInfo.decoder,
      fallback: decodeInfo.fallback || null,
      sourceSampleRate: decodeInfo.sampleRate,
      channels: decodeInfo.channels,
      analysisSampleRate: ANALYSIS_PARAMS.sampleRateTarget,
      note: decodeInfo.fallback ? '浏览器不支持主路径流式解码，使用了整文件解码降级，检测参数与算法不变' : null,
    },
    analysisParameters: ANALYSIS_PARAMS,
    featureSummary: featureMeta,
    detection: {
      stats: analysisResult.stats,
      globalProcessing: analysisResult.globalProcessing,
      findings: analysisResult.findings,
      globalFindings: analysisResult.globalFindings,
    },
    custody: {
      entryCount: custodyEntries.length,
      chainTip: chainTip(custodyEntries),
      entries: custodyEntries,
    },
    integrity: {
      analysisHash: null, // 下方填充
      verificationRule: '以相同文件与 analysisParameters 重算，analysisHash 必须一致；保管链 entryHash 必须逐条通过',
    },
  };
  report.integrity.analysisHash = analysisHash;
  return report;
}

// 报告自身的整体哈希（写入导出文件名/校验页）
export async function reportHash(report) {
  return sha256Hex(new TextEncoder().encode(canonicalJSON(report)));
}

export function downloadJSON(report, fileName) {
  const blob = new Blob([canonicalJSON(report)], { type: 'application/json' });
  triggerDownload(blob, fileName);
}

export function downloadBlob(blob, fileName) {
  triggerDownload(blob, fileName);
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
