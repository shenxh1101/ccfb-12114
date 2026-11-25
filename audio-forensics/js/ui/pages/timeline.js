// 页面 3：时间线 —— 峰值包络波形 + 疑点标记 + 点击/缩放定位 + 单帧线索明细
import { h, clear, confidenceBadge, badge } from '../dom.js';
import { listEvidence, getLatestAnalysis } from '../../core/store.js';
import { formatTime } from '../../core/util.js';
import { navigate } from '../app.js';

const COLORS = {
  high: '#e5534b', medium: '#e0a449', low: '#4da3ff',
  waveform: '#3d6fa3', waveformFill: 'rgba(77,163,255,.28)',
  grid: '#232c37', text: '#5d6b7c', cursor: '#9fb4cc',
};

export async function renderTimeline(view, param) {
  clear(view);
  const all = await listEvidence();
  if (!all.length) {
    view.append(empty('请先导入并分析录音'));
    return;
  }
  const evidence = all.find(e => e.evidenceId === param) || all[0];
  const rec = await getLatestAnalysis(evidence.evidenceId);
  if (!rec) {
    view.append(h('div', { class: 'empty' },
      h('div', { class: 'big' }, '该证据尚无分析结果'),
      h('button', { class: 'primary', style: 'margin-top:14px', onclick: () => navigate('#/detect/' + evidence.evidenceId) }, '前往检测')));
    return;
  }

  const { peakEnv, durationSec } = rec.waveform;
  const findings = rec.analysisResult.findings.filter(f => f.kind === 'splice');
  const state = {
    viewStart: 0, viewEnd: durationSec,
    cursor: parseJumpTime() ?? null,
    selected: null,
  };

  const canvas = h('canvas', { id: 'timeline-canvas', height: 220 });
  const ctx = canvas.getContext('2d');
  const detail = h('div', { class: 'tl-detail' });

  function draw() {
    fitCanvas(canvas);
    drawWave(ctx, canvas, peakEnv, durationSec, state, findings);
  }

  const zoomIn = h('button', { class: 'small', onclick: () => zoom(0.5) }, '放大');
  const zoomOut = h('button', { class: 'small', onclick: () => zoom(2) }, '缩小');
  const reset = h('button', { class: 'small', onclick: () => { state.viewStart = 0; state.viewEnd = durationSec; draw(); } }, '全程');
  const posLabel = h('span', { class: 'faint mono', style: 'font-size:12px' }, '区间 00:00.000 — ' + formatTime(durationSec));

  view.append(
    h('div', { class: 'card' },
      h('h2', {}, `时间线 · ${evidence.fileName} `, h('span', { class: 'hint' }, `时长 ${formatTime(durationSec)} · ${findings.length} 个拼接疑点`)),
      h('div', { class: 'tl-toolbar' }, zoomIn, zoomOut, reset, posLabel,
        h('span', { class: 'faint', style: 'font-size:12px' }, '点击波形定位，滚轮以光标为中心缩放')),
      canvas,
      h('div', { class: 'row tight', style: 'margin-top:10px' },
        legend(COLORS.high, '高置信'), legend(COLORS.medium, '中置信'), legend(COLORS.low, '低置信'),
        h('span', { class: 'faint', style: 'font-size:12px' }, '标记位置即疑点时间戳')),
    ),
    h('div', { class: 'card' }, h('h2', {}, '疑点明细'), detail),
  );

  draw();
  renderDetail(null);
  if (state.cursor !== null) selectAt(state.cursor);

  function zoom(factor) {
    const center = (state.viewStart + state.viewEnd) / 2;
    const half = ((state.viewEnd - state.viewStart) * factor) / 2;
    state.viewStart = Math.max(0, center - half);
    state.viewEnd = Math.min(durationSec, center + half);
    if (state.viewEnd - state.viewStart < 0.05) { state.viewEnd = Math.min(durationSec, state.viewStart + 0.05); }
    updateLabel(); draw();
  }
  function updateLabel() {
    posLabel.textContent = `区间 ${formatTime(state.viewStart)} — ${formatTime(state.viewEnd)}`;
  }

  canvas.addEventListener('click', ev => {
    const t = xToTime(ev.offsetX, canvas, state);
    state.cursor = t;
    selectAt(t);
    draw();
  });
  canvas.addEventListener('wheel', ev => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 0.7 : 1.4;
    const anchor = xToTime(ev.offsetX, canvas, state);
    const span = state.viewEnd - state.viewStart;
    const left = (anchor - state.viewStart) / span;
    const newSpan = Math.min(durationSec, Math.max(0.05, span * factor));
    state.viewStart = Math.max(0, Math.min(anchor - newSpan * left, durationSec - newSpan));
    state.viewEnd = state.viewStart + newSpan;
    updateLabel(); draw();
  }, { passive: false });
  window.addEventListener('resize', draw, { once: true });

  function selectAt(t) {
    let best = null, bestDist = Infinity;
    for (const f of findings) {
      const d = Math.abs(f.timeSec - t);
      if (d < bestDist) { best = f; bestDist = d; }
    }
    state.selected = best;
    renderDetail(best, bestDist);
  }

  function renderDetail(f, dist) {
    clear(detail);
    if (!f) {
      detail.append(h('div', { class: 'faint' }, '点击波形选择最近的疑点查看线索构成'));
      return;
    }
    const cueNames = { noiseStep: '背景噪声台阶', spectralFlux: '梅尔谱通量', mfccBreak: 'MFCC 断点', zeroRate: '过零率突变', energyBreak: '能量断点' };
    detail.append(
      h('div', { class: 'row tight', style: 'margin-bottom:10px' },
        h('strong', { class: 'mono' }, formatTime(f.timeSec)),
        confidenceBadge(f.confidence),
        badge(`综合分 ${f.score?.toFixed(2) ?? '—'}`, 'info'),
        badge(`距点击 ${dist.toFixed(3)}s`, 'low'),
        h('span', { class: 'faint' }, f.classification)),
      ...Object.entries(f.cues).map(([k, v]) => h('div', { class: 'cue-row' },
        h('span', {}, cueNames[k] || k),
        h('span', { class: 'mono', style: `color:${v >= 3.5 ? '#e0a449' : '#8b98a8'}` }, '鲁棒 z = ' + v.toFixed(3)))),
      h('div', { class: 'section-title' }, '判定依据'),
      h('ul', { class: 'reasons' }, ...f.reasons.map(r => h('li', {}, r))),
    );
  }
}

function drawWave(ctx, canvas, env, duration, state, findings) {
  const w = canvas.width, hgt = canvas.height;
  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = '#0a0d11';
  ctx.fillRect(0, 0, w, hgt);
  // 网格
  ctx.strokeStyle = COLORS.grid; ctx.fillStyle = COLORS.text;
  ctx.font = '10px monospace'; ctx.lineWidth = 1;
  const ticks = 10;
  for (let i = 0; i <= ticks; i++) {
    const x = (i / ticks) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hgt - 16); ctx.stroke();
    const t = state.viewStart + (i / ticks) * (state.viewEnd - state.viewStart);
    ctx.fillText(formatTime(t), x + 3, hgt - 4);
  }
  // 波形（按可视区间映射包络索引）
  const n = env.length;
  const mid = (hgt - 20) / 2 + 2;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let x = 0; x < w; x++) {
    const t = state.viewStart + (x / w) * (state.viewEnd - state.viewStart);
    const idx = Math.min(n - 1, Math.max(0, Math.floor((t / duration) * n)));
    const y = mid - env[idx] * (mid - 8);
    ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COLORS.waveform; ctx.lineWidth = 1.2; ctx.stroke();
  // 镜像填充
  ctx.lineTo(w, mid);
  for (let x = w - 1; x >= 0; x--) {
    const t = state.viewStart + (x / w) * (state.viewEnd - state.viewStart);
    const idx = Math.min(n - 1, Math.max(0, Math.floor((t / duration) * n)));
    ctx.lineTo(x, mid + env[idx] * (mid - 8));
  }
  ctx.closePath(); ctx.fillStyle = COLORS.waveformFill; ctx.fill();

  // 疑点标记
  for (const f of findings) {
    if (f.timeSec < state.viewStart || f.timeSec > state.viewEnd) continue;
    const x = timeToX(f.timeSec, canvas, state);
    ctx.strokeStyle = COLORS[f.confidence] || COLORS.low;
    ctx.lineWidth = f.confidence === 'high' ? 2 : 1.4;
    ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, hgt - 18); ctx.stroke();
    ctx.fillStyle = COLORS[f.confidence];
    ctx.beginPath(); ctx.moveTo(x - 5, 2); ctx.lineTo(x + 5, 2); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill();
  }
  // 光标
  if (state.cursor !== null && state.cursor >= state.viewStart && state.cursor <= state.viewEnd) {
    const x = timeToX(state.cursor, canvas, state);
    ctx.strokeStyle = COLORS.cursor; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hgt - 16); ctx.stroke(); ctx.setLineDash([]);
  }
}

function fitCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const cssW = canvas.parentElement.clientWidth - 40;
  canvas.style.width = cssW + 'px';
  canvas.width = Math.floor(cssW * ratio);
  canvas.height = Math.floor(220 * ratio);
  canvas.getContext('2d').scale(ratio, ratio);
  canvas.width = Math.floor(cssW); // 以 CSS 像素为绘图坐标，保证点击映射简单
  canvas.height = 220;
}
function timeToX(t, canvas, state) {
  return ((t - state.viewStart) / (state.viewEnd - state.viewStart)) * canvas.clientWidth;
}
function xToTime(x, canvas, state) {
  return state.viewStart + (x / canvas.clientWidth) * (state.viewEnd - state.viewStart);
}
function legend(color, text) {
  return h('span', { class: 'row tight', style: 'align-items:center;gap:6px;font-size:12px;color:var(--text-dim)' },
    h('span', { style: `width:10px;height:10px;border-radius:2px;background:${color};display:inline-block` }), text);
}
function empty(msg) {
  return h('div', { class: 'empty' }, h('div', { class: 'big' }, msg));
}
function parseJumpTime() {
  const m = location.hash.match(/[?&]t=([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
}
