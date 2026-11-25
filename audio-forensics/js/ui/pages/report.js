// 页面 5：报告 —— JSON 为完整权威记录，PDF 仅为打印展示；导出动作全部写入保管链。
import { h, clear, toast, badge, confidenceBadge, shortHash } from '../dom.js';
import {
  listEvidence, getLatestAnalysis, buildEvidenceReport, recordExport, CUSTODY_ACTIONS,
} from '../../core/store.js';
import { reportHash, downloadJSON } from '../../core/report.js';
import { formatTime } from '../../core/util.js';
import { navigate } from '../app.js';

export async function renderReport(view, param) {
  clear(view);
  const all = await listEvidence();
  if (!all.length) { view.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '请先导入证据'))); return; }
  const evidence = all.find(e => e.evidenceId === param) || all[0];
  const analysis = await getLatestAnalysis(evidence.evidenceId);
  if (!analysis) {
    view.append(h('div', { class: 'empty' }, h('div', { class: 'big' }, '尚无分析结果'),
      h('button', { class: 'primary', style: 'margin-top:14px', onclick: () => navigate('#/detect/' + evidence.evidenceId) }, '前往检测')));
    return;
  }

  const report = await buildEvidenceReport(evidence, analysis);
  const rHash = await reportHash(report);
  const pretty = JSON.stringify(report, null, 2);

  const summary = h('div', { class: 'card' },
    h('h2', {}, '报告概览'),
    h('dl', { class: 'kv' },
      h('dt', {}, '报告模式'), h('dd', {}, badge('AF-REPORT-1.0 · 全字段 JSON', 'info')),
      h('dt', {}, '证据文件哈希'), h('dd', { class: 'mono strike-verify' }, report.evidence.fileSha256),
      h('dt', {}, '分析指纹'), h('dd', { class: 'mono strike-verify' }, report.integrity.analysisHash),
      h('dt', {}, '报告整体哈希'), h('dd', { class: 'mono strike-verify' }, rHash),
      h('dt', {}, '保管链条目'), h('dd', {}, String(report.custody.entryCount) + ' · 链尾 ' + shortHash(report.custody.chainTip, 20)),
      h('dt', {}, '疑点统计'), h('dd', {}, JSON.stringify(report.detection.stats)),
    ),
    h('div', { class: 'row tight', style: 'margin-top:16px' },
      h('button', { class: 'primary', onclick: () => exportJson() }, '导出完整 JSON 报告'),
      h('button', { onclick: () => printPdf() }, '打印 / 另存为 PDF'),
      h('button', { onclick: () => navigate('#/detect/' + evidence.evidenceId) }, '返回检测'),
    ),
    h('div', { class: 'faint', style: 'margin-top:10px;font-size:12.3px' },
      'JSON 是权威记录，包含容器结构、全部参数、每疑点的线索原始指标与保管链；PDF 只用于展示，不承载证据效力。两次导出均写入保管链。'),
  );

  const printView = h('div', { class: 'card' },
    h('h2', {}, '打印视图（PDF 展示内容）'),
    printable(report),
  );

  const jsonCard = h('div', { class: 'card' },
    h('h2', {}, '完整 JSON（可折叠核对） ', h('span', { class: 'hint' }, '键序固定，可直接用于复算哈希')),
    h('div', { class: 'report-json' }, pretty),
  );

  view.append(summary, printView, jsonCard);

  async function exportJson() {
    const name = `forensic-report-${evidence.evidenceId}-${stamp()}.json`;
    downloadJSON(report, name);
    await recordExport(evidence.evidenceId, CUSTODY_ACTIONS.EXPORT_REPORT, name, rHash, {
      analysisHash: report.integrity.analysisHash, format: 'json',
    });
    toast('JSON 报告已导出并登记保管链', 'ok');
  }

  async function printPdf() {
    const name = `forensic-report-${evidence.evidenceId}-${stamp()}.pdf`;
    await recordExport(evidence.evidenceId, CUSTODY_ACTIONS.EXPORT_PDF, name, rHash, {
      analysisHash: report.integrity.analysisHash, format: 'pdf-print',
    });
    toast('已登记导出事件，正在打开打印对话框（选择“存储为 PDF”）', 'ok', 5000);
    setTimeout(() => window.print(), 400);
  }
}

function printable(r) {
  const s = r.detection.stats;
  return h('div', { id: 'printable-report' },
    h('h2', { style: 'margin-top:0' }, '音频完整性校验报告'),
    h('dl', { class: 'kv' },
      h('dt', {}, '生成时间'), h('dd', {}, r.generatedAt),
      h('dt', {}, '工具'), h('dd', {}, `${r.tool.name} ${r.tool.version}（${r.tool.mode}）`),
      h('dt', {}, '证据编号'), h('dd', {}, r.evidence.evidenceId),
      h('dt', {}, '原始文件名'), h('dd', {}, r.evidence.originalFileName),
      h('dt', {}, '文件 SHA-256'), h('dd', { class: 'mono' }, r.evidence.fileSha256),
      h('dt', {}, '容器格式'), h('dd', {}, r.container.detectedFormat),
      h('dt', {}, '时长'), h('dd', {}, formatTime(r.featureSummary.durationSec)),
      h('dt', {}, '分析指纹'), h('dd', { class: 'mono' }, r.integrity.analysisHash),
    ),
    h('div', { class: 'section-title' }, '检测统计'),
    h('div', { class: 'row tight' },
      badge(`拼接疑点 ${s.splicePoints}`, s.splicePoints ? 'bad' : 'ok'),
      badge(`高 ${s.high} / 中 ${s.medium} / 低 ${s.low}`, 'info'),
      badge(`容器异常 ${s.containerAnomalies}`, 'warn')),
    h('div', { class: 'section-title' }, '疑点清单'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, '时间戳'), h('th', {}, '置信度'), h('th', {}, '分类'), h('th', {}, '依据'))),
      h('tbody', {}, r.detection.findings.filter(f => f.kind === 'splice').map((f, i) => h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', { class: 'mono' }, formatTime(f.timeSec)),
        h('td', {}, f.confidence),
        h('td', {}, f.classification),
        h('td', {}, f.reasons.join('；'))))),
    ),
    h('div', { class: 'section-title' }, '全局处理痕迹'),
    h('ul', { class: 'reasons' },
      ...(r.detection.globalFindings.length
        ? r.detection.globalFindings.flatMap(f => f.reasons.map(x => h('li', {}, x)))
        : [h('li', {}, '未发现整段重采样或重编码特征')])),
    h('div', { class: 'section-title' }, '保管链摘要'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, '动作'), h('th', {}, '时间'), h('th', {}, 'entryHash'))),
      h('tbody', {}, r.custody.entries.map(e => h('tr', {},
        h('td', {}, String(e.seq)), h('td', {}, e.action),
        h('td', {}, e.timestamp), h('td', { class: 'mono' }, shortHash(e.entryHash, 22))))),
    ),
    h('p', { class: 'faint', style: 'margin-top:16px;font-size:12px' },
      '本 PDF 为展示视图；完整证据以同案 JSON 报告为准，校验规则：相同文件与 analysisParameters 重算 analysisHash 必须一致，保管链 entryHash 逐条通过。'),
  );
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}
