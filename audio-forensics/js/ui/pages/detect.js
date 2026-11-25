// 页面 2：篡改检测
import { h, clear, toast, confidenceBadge, badge, shortHash } from '../dom.js';
import {
  listEvidence, getEvidence, runAnalysis, listAnalyses, getLatestAnalysis,
} from '../../core/store.js';
import { formatTime, formatBytes } from '../../core/util.js';
import { navigate } from '../app.js';

export async function renderDetect(view, param) {
  clear(view);
  const evidence = await pickEvidence(view, param);
  if (!evidence) {
    view.append(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '请先在「证据导入」页录入录音'),
      h('button', { class: 'primary', style: 'margin-top:14px', onclick: () => navigate('#/import') }, '前往导入')));
    return;
  }

  const head = h('div', { class: 'card' },
    h('h2', {}, '检测对象'),
    h('dl', { class: 'kv' },
      h('dt', {}, '证据编号'), h('dd', { class: 'mono' }, evidence.evidenceId),
      h('dt', {}, '文件名'), h('dd', {}, evidence.fileName),
      h('dt', {}, '文件哈希'), h('dd', { class: 'mono strike-verify' }, evidence.fileHash),
      h('dt', {}, '大小 / 魔数'), h('dd', {}, `${formatBytes(evidence.fileSize)} · ${evidence.detectedMagic}`),
    ),
  );

  const progressCard = h('div', { class: 'card', hidden: true },
    h('h2', {}, '分析进度'),
    h('div', { class: 'progress' }, h('div')),
    h('div', { class: 'faint', style: 'margin-top:8px;font-size:12.5px' }, '初始化…'),
  );

  const resultHost = h('div', {});
  view.append(head, progressCard, resultHost);

  const runBtn = h('button', { class: 'primary', onclick: () => start() }, '开始完整性检测');
  head.append(h('div', { class: 'row tight', style: 'margin-top:14px' }, runBtn,
    h('button', { onclick: () => navigate('#/timeline/' + evidence.evidenceId) }, '查看时间线'),
    h('button', { onclick: () => navigate('#/report/' + evidence.evidenceId) }, '生成报告')));

  await showLatest();

  async function start() {
    runBtn.disabled = true;
    progressCard.hidden = false;
    const bar = progressCard.querySelector('.progress > div');
    const label = progressCard.querySelector('.faint');
    try {
      const rec = await runAnalysis(evidence, msg => {
        bar.style.width = `${Math.round(msg.ratio * 100)}%`;
        label.textContent = `${msg.message} · ${Math.round(msg.ratio * 100)}%`;
      });
      bar.style.width = '100%';
      toast(`检测完成：${rec.analysisResult.stats.splicePoints} 个拼接疑点，分析指纹 ${shortHash(rec.analysisHash, 12)}`);
      setTimeout(() => { progressCard.hidden = true; }, 900);
      await showLatest();
    } catch (err) {
      toast('检测失败：' + err.message, 'err', 8000);
      label.textContent = '失败：' + err.message;
    } finally {
      runBtn.disabled = false;
    }
  }

  async function showLatest() {
    clear(resultHost);
    const analyses = await listAnalyses(evidence.evidenceId);
    if (!analyses.length) {
      resultHost.append(h('div', { class: 'empty' },
        h('div', { class: 'big' }, '尚未分析'),
        h('div', {}, '点击「开始完整性检测」，分析在 Web Worker 中按块执行，页面保持可交互')));
      return;
    }
    const latest = analyses[0];
    resultHost.append(renderStats(latest), renderGlobal(latest), renderFindings(latest), renderHistory(analyses));
  }
}

function renderStats(rec) {
  const s = rec.analysisResult.stats;
  const grid = h('div', { class: 'stat-grid' },
    stat(s.splicePoints, '拼接疑点', s.splicePoints ? 'red' : 'green'),
    stat(s.high, '高置信', 'red'),
    stat(s.medium, '中置信', 'amber'),
    stat(s.containerAnomalies, '容器异常', 'amber'),
  );
  return h('div', { class: 'card' },
    h('h2', {}, '检测结论 ', h('span', { class: 'hint' }, `分析指纹 ${rec.analysisHash.slice(0, 20)}…`)),
    grid,
    h('div', { class: 'faint', style: 'font-size:12px;margin-top:6px' },
      `解码器：${rec.decodeInfo.decoder}${rec.decodeInfo.fallback ? '（降级：' + rec.decodeInfo.fallback + '）' : ''} · 分析帧 ${rec.featureMeta.analysisFrames} · 时长 ${formatTime(rec.featureMeta.durationSec)}`));
}

function stat(v, l, cls) {
  return h('div', { class: `stat ${cls}` }, h('div', { class: 'v' }, String(v)), h('div', { class: 'l' }, l));
}

function renderGlobal(rec) {
  const g = rec.analysisResult.globalFindings || [];
  if (!g.length) {
    return h('div', { class: 'card' },
      h('h2', {}, '全局处理痕迹'),
      h('div', { class: 'row tight' }, badge('未发现整段重采样', 'ok'), badge('未发现整段重编码', 'ok')),
      h('div', { class: 'faint', style: 'margin-top:8px;font-size:12.3px' },
        '未检出覆盖全段的重采样/重编码特征，局部疑点按拼接逻辑判定，假阳性风险较低'));
  }
  return h('div', { class: 'card' },
    h('h2', {}, '全局处理痕迹（用于区分假阳性）'),
    ...g.map(f => h('div', { style: 'margin-bottom:12px' },
      h('div', { class: 'row tight', style: 'margin-bottom:6px' },
        badge(f.kind === 'resample' ? '整段重采样' : '整段重编码', f.confidence === 'high' ? 'bad' : 'warn'),
        h('span', { class: 'faint' }, f.classification)),
      h('ul', { class: 'reasons' }, ...f.reasons.map(r => h('li', {}, r))),
    )),
  );
}

function renderFindings(rec) {
  const splices = rec.analysisResult.findings.filter(f => f.kind === 'splice');
  const containers = rec.analysisResult.findings.filter(f => f.kind === 'container');
  const rows = splices.map(f => h('tr', {},
    h('td', { class: 'mono clickable', onclick: () => navigate('#/timeline/' + rec.evidenceId + '?t=' + f.timeSec) }, formatTime(f.timeSec)),
    h('td', {}, confidenceBadge(f.confidence)),
    h('td', { class: 'mono' }, f.score.toFixed(2)),
    h('td', {}, String(f.cueAgreement)),
    h('td', {}, classifyBadge(f.classification)),
    h('td', {}, h('ul', { class: 'reasons' }, ...f.reasons.slice(0, 3).map(r => h('li', {}, r)))),
  ));
  const cRows = containers.map(f => h('tr', {},
    h('td', { class: 'mono' }, '容器层'),
    h('td', {}, confidenceBadge(f.confidence)),
    h('td', {}, '—'), h('td', {}, '0'),
    h('td', {}, badge('容器异常', 'warn')),
    h('td', {}, h('ul', { class: 'reasons' }, ...f.reasons.map(r => h('li', {}, r)))),
  ));
  return h('div', { class: 'card' },
    h('h2', {}, `疑点列表（${splices.length + containers.length}） `,
      h('span', { class: 'hint' }, '相同文件与参数重复检测，列表顺序、时间戳、置信度完全一致')),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '时间戳'), h('th', {}, '置信度'), h('th', {}, '综合分'),
        h('th', {}, '线索数'), h('th', {}, '分类'), h('th', {}, '判定依据'))),
      h('tbody', {}, ...rows, ...cRows)),
  );
}

function classifyBadge(label) {
  if (label === 'multi-cue-splice') return badge('多线索拼接', 'bad');
  if (label === 'likely-reencode-artifact') return badge('疑似重编码伪影', 'warn');
  return badge('单线索待复核', 'info');
}

function renderHistory(analyses) {
  const sameHash = analyses.every(a => a.analysisHash === analyses[0].analysisHash);
  return h('div', { class: 'card' },
    h('h2', {}, `历史分析（${analyses.length}） `,
      h('span', { class: 'hint' }, sameHash ? '全部分析指纹一致 → 可复现性通过' : '指纹不一致，参数或文件已变化')),
    h('div', { class: 'row tight' }, sameHash ? badge('可复现 ✓', 'ok') : badge('结果不一致', 'bad')),
    h('table', { style: 'margin-top:10px' },
      h('thead', {},
        h('tr', {},
          h('th', {}, '时间'), h('th', {}, '分析 ID'), h('th', {}, '指纹（前 18 位）'), h('th', {}, '解码器'))),
      h('tbody', {},
        ...analyses.map(a => h('tr', {},
          h('td', { class: 'faint' }, new Date(a.createdAt).toLocaleString()),
          h('td', { class: 'mono' }, a.analysisId),
          h('td', { class: 'hash-cell' }, shortHash(a.analysisHash, 20)),
          h('td', {}, a.decodeInfo.decoder))))),
  );
}

async function pickEvidence(view, param) {
  const all = await listEvidence();
  if (!all.length) return null;
  if (param) {
    const exact = all.find(e => e.evidenceId === param);
    if (exact) return exact;
  }
  const latest = await getLatestAnalysis(all[0].evidenceId);
  return all[0];
}
