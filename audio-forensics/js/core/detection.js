// 篡改检测引擎：把逐帧特征转换为带时间戳与置信度的疑点列表。
// 全部输入相同 → 输出严格一致（无随机量、无平台相关分支）。
//
// 方法论：
//  - 先对每条“边界跳变序列”在整段范围内做 MAD 鲁棒标准化（全局鲁棒 z），
//    局部滑窗会把真正的台阶当作新常态“自适应”掉，全局基线不会；
//  - 背景噪声连续性用“安静帧高频本底中值”的边界台阶度量，不受语音内容主导；
//  - 重采样（带宽塌缩）与重编码（全段谱压缩/编码网格周期）单独成类，
//    用于把处理伪影与真实拼接点区分开，避免假阳性立案。
import { ANALYSIS_PARAMS, FINDING_KIND } from './constants.js';
import { robustZScore, diff, median, mean, coefficientOfVariation } from './util.js';

const P = ANALYSIS_PARAMS;
const G = P.globalZ;

// 序列的全局鲁棒 z：以整段中位数/MAD 为基线；MAD 退化（大量等值）时回退到标准差
function globalRobustZ(values) {
  const med = median(values);
  let mad = 0;
  for (const v of values) mad += Math.abs(v - med);
  mad /= values.length;
  const out = new Float64Array(values.length);
  let scale = 1.4826 * mad;
  if (scale < 1e-9) {
    let variance = 0;
    for (const v of values) variance += (v - med) * (v - med);
    scale = Math.sqrt(variance / values.length);
  }
  if (scale < 1e-12) return out; // 常量序列
  for (let i = 0; i < values.length; i++) out[i] = (values[i] - med) / scale;
  return out;
}

// 边界两侧中值差
function boundaryMedianDelta(series, i, win) {
  const lo = Math.max(0, i - win), hi = Math.min(series.length, i + win + 1);
  const left = [], right = [];
  for (let j = lo; j <= i; j++) left.push(series[j]);
  for (let j = i + 1; j < hi; j++) right.push(series[j]);
  return median(right) - median(left);
}

function euclidean(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// 安静帧掩码：按 RMS 取全段最安静的 quietFrameRatio 比例帧
function quietFrameMask(rmsDb) {
  const order = rmsDb.map((v, i) => i).sort((a, b) => rmsDb[a] - rmsDb[b]);
  const keep = Math.max(1, Math.floor(order.length * P.quietFrameRatio));
  const mask = new Uint8Array(rmsDb.length);
  for (let k = 0; k < keep; k++) mask[order[k]] = 1;
  return mask;
}

/**
 * 计算全部候选边界的逐线索得分（全局鲁棒 z）
 */
export function scoreBoundaries(feat) {
  const n = feat.frames;
  const { hfNoiseDb, rmsDb, zcr, mfcc, times } = feat;
  const shortWin = P.boundaryWindow;
  const longWin = Math.max(1, Math.round(P.floorWindowSec * feat.frameRate));
  const quiet = quietFrameMask(rmsDb);

  // 1) 背景噪声台阶（主线索）：长窗内仅取安静帧，估计两侧高频本底中值差。
  //    样本不足的边界不评本底线索（置 0），避免语音段产生假台阶。
  const noiseStepRaw = new Float64Array(n);
  const energyBreakRaw = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const lLo = Math.max(0, i - longWin), lHi = i;
    const rLo = i + 1, rHi = Math.min(n, i + longWin + 1);
    const lQ = [], rQ = [];
    for (let j = lLo; j <= lHi; j++) if (quiet[j]) lQ.push(hfNoiseDb[j]);
    for (let j = rLo; j < rHi; j++) if (quiet[j]) rQ.push(hfNoiseDb[j]);
    if (lQ.length >= P.floorMinQuietFrames && rQ.length >= P.floorMinQuietFrames) {
      noiseStepRaw[i] = Math.abs(median(rQ) - median(lQ));
    }
    // 能量断点用短窗（瞬态特征）
    const eLo = Math.max(0, i - shortWin), eHi = Math.min(n, i + shortWin + 1);
    const lE = [], rE = [];
    for (let j = eLo; j <= i; j++) lE.push(rmsDb[j]);
    for (let j = i + 1; j < eHi; j++) rE.push(rmsDb[j]);
    energyBreakRaw[i] = Math.abs(median(rE) - median(lE));
  }

  // 2) 频谱通量：相邻帧梅尔谱 L1 跳变
  const flux = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let s = 0;
    const a = feat.melLog[i - 1], b = feat.melLog[i];
    for (let m = 0; m < a.length; m++) s += Math.abs(b[m] - a[m]);
    flux[i] = s;
  }

  // 3) MFCC 断点
  const mfccDist = new Float64Array(n);
  for (let i = 1; i < n; i++) mfccDist[i] = euclidean(mfcc[i - 1], mfcc[i]);

  // 4) 过零率突变
  const zcrDiff = new Float64Array(n);
  const zd = diff(zcr);
  for (let i = 1; i < n; i++) zcrDiff[i] = Math.abs(zd[i]);

  // 全局鲁棒 z（取正向幅度）
  const z = {
    noiseStep: globalRobustZ(noiseStepRaw),
    spectralFlux: globalRobustZ(flux),
    mfccBreak: globalRobustZ(mfccDist),
    zeroRate: globalRobustZ(zcrDiff),
    energyBreak: globalRobustZ(energyBreakRaw),
  };

  const candidates = [];
  for (let i = 1; i < n - 1; i++) {
    candidates.push({
      frame: i,
      timeSec: times[i],
      cues: {
        noiseStep: z.noiseStep[i],
        spectralFlux: z.spectralFlux[i],
        mfccBreak: z.mfccBreak[i],
        zeroRate: z.zeroRate[i],
        energyBreak: z.energyBreak[i],
      },
      raw: {
        hfNoiseStepDb: round(noiseStepRaw[i], 4),
        energyBreakDb: round(energyBreakRaw[i], 4),
        spectralFlux: round(flux[i], 5),
        mfccDistance: round(mfccDist[i], 5),
        zcrDelta: round(zcrDiff[i], 6),
        flatness: round(feat.flatness[i], 6),
        absoluteFloorGatePassed: noiseStepRaw[i] >= P.floorStepAbsoluteDb,
      },
    });
  }
  return { candidates, cueSeries: z, frameRate: feat.frameRate };
}

// 非极大值抑制：固定半径内只保留综合分最高的候选
function nonMaxSuppression(cands, radiusFrames) {
  const kept = [];
  const used = new Uint8Array(cands.length);
  const order = cands.map((c, idx) => idx).sort((a, b) => cands[b].score - cands[a].score);
  for (const idx of order) {
    if (used[idx]) continue;
    kept.push(cands[idx]);
    used[idx] = 1;
    for (let j = 0; j < cands.length; j++) {
      if (!used[j] && Math.abs(cands[j].frame - cands[idx].frame) <= radiusFrames) used[j] = 1;
    }
  }
  kept.sort((a, b) => a.frame - b.frame);
  return kept;
}

function mergeByGap(cands, minGapFrames) {
  if (cands.length <= 1) return cands;
  const out = [cands[0]];
  for (let i = 1; i < cands.length; i++) {
    const last = out[out.length - 1];
    if (cands[i].frame - last.frame < minGapFrames) {
      if (cands[i].score > last.score) out[out.length - 1] = cands[i];
    } else out.push(cands[i]);
  }
  return out;
}

function confidenceFromScore(score) {
  if (score >= G.confidence.high) return 'high';
  if (score >= G.confidence.medium) return 'medium';
  if (score >= G.confidence.low) return 'low';
  return null;
}

/**
 * 全局处理痕迹检测
 *  - 重采样：先降后升的重采样在原奈奎斯特限以上几乎无能量，安静帧高频本底深度塌缩；
 *    该特征全段持续存在，与“局部台阶”形态完全不同。
 *  - 重编码：感知编码全段压制谱细节（谱平坦度变异系数偏低），MP3 还留下编码网格周期性。
 */
export function detectGlobalProcessing(feat, containerInfo) {
  const n = feat.frames;
  const quiet = quietFrameMask(feat.rmsDb);
  const quietHf = [], quietFull = [];
  for (let i = 0; i < n; i++) {
    if (quiet[i]) {
      quietHf.push(feat.hfNoiseDb[i]);
      quietFull.push(feat.fullBandDb[i]);
    }
  }
  const hfFloor = median(quietHf);
  const fullFloor = median(quietFull);
  const hfDrop = fullFloor - hfFloor;                 // 高频相对全带的衰减量（dB，越大越像带宽受限）
  const flatCv = coefficientOfVariation(feat.flatness);
  const centroidCv = coefficientOfVariation(feat.centroid);

  const resampleEvidence = {
    quietFrameHfFloorDb: round(hfFloor, 3),
    quietFrameFullBandFloorDb: round(fullFloor, 3),
    hfBandwidthDropDb: round(hfDrop, 3),
    flatnessCv: round(flatCv, 4),
    centroidCv: round(centroidCv, 4),
  };
  const resampled = hfFloor < P.resampleHfFloorDb && hfDrop > P.resampleHfDropDb;

  const periodicity = detectCodecPeriodicity(feat, containerInfo);
  const reencoded = periodicity.detected ||
    (containerInfo && containerInfo.detectedFormat === 'audio/mpeg' && flatCv < P.resampleFlatnessCv);

  return {
    resampled,
    reencoded,
    codecPeriodicity: periodicity,
    evidence: resampleEvidence,
  };
}

function detectCodecPeriodicity(feat, containerInfo) {
  if (!containerInfo || containerInfo.detectedFormat !== 'audio/mpeg') {
    return { detected: false, hits: 0, checks: 0, periodFrames: null };
  }
  const sr = containerInfo.sampleRate;
  const frameDur = sr === 22050 ? 576 / sr : 1152 / sr;
  const periodFrames = Math.round(frameDur * feat.frameRate);
  if (periodFrames < 3) return { detected: false, hits: 0, checks: 0, periodFrames };
  // 预计算逐帧通量
  const flux = new Float64Array(feat.frames);
  for (let i = 1; i < feat.frames; i++) {
    let s = 0;
    const a = feat.melLog[i - 1], b = feat.melLog[i];
    for (let m = 0; m < a.length; m++) s += Math.abs(b[m] - a[m]);
    flux[i] = s;
  }
  let hits = 0, checks = 0;
  for (let i = periodFrames; i < feat.frames - 1; i += periodFrames) {
    checks++;
    const around = [];
    for (let j = Math.max(1, i - 2); j <= Math.min(feat.frames - 2, i + 2); j++) around.push(flux[j]);
    const peak = Math.max(...around);
    const baseline = mean(around);
    if (peak > baseline * 1.8) hits++;
  }
  return {
    detected: checks > 0 && hits / checks > 0.6 && hits >= P.mp3PeriodicityMinHits,
    hits, checks, periodFrames,
  };
}

const CUE_NAMES = {
  noiseStep: '背景噪声本底台阶（安静帧高频带）',
  spectralFlux: '梅尔谱通量断点',
  mfccBreak: 'MFCC 倒谱断点',
  zeroRate: '过零率突变',
  energyBreak: '帧能量断点',
};

/**
 * 主入口：特征 + 容器信息 → 完整检测结果
 */
export function analyze(feat, containerInfo) {
  const { candidates } = scoreBoundaries(feat);
  const globalInfo = detectGlobalProcessing(feat, containerInfo);

  for (const c of candidates) {
    let score = 0;
    for (const key of Object.keys(P.weights)) {
      score += P.weights[key] * Math.max(0, c.cues[key]);
    }
    c.score = round(score, 4);
    // 本底台阶需同时通过相对鲁棒 z 与绝对 dB 门槛，防止语音波动被误判
    c.firedCues = Object.entries(c.cues)
      .filter(([k, v]) => {
        if (k !== 'noiseStep') return v >= G.cueThreshold;
        return v >= G.cueThreshold && c.raw.hfNoiseStepDb >= P.floorStepAbsoluteDb;
      })
      .map(([k]) => k);
  }

  const radiusFrames = Math.max(1, Math.round(P.nmsRadiusSec * feat.frameRate));
  let kept = nonMaxSuppression(candidates, radiusFrames);
  kept = mergeByGap(kept, P.minGapSec * feat.frameRate);

  const findings = [];
  for (const c of kept) {
    const level = confidenceFromScore(c.score);
    if (!level) continue;
    // 单线索孤证（无多线索印证）降级，且低置信度不立案
    if (c.firedCues.length < 2 && level === 'low') continue;
    // 没有本底台阶证据、仅谱线索触发的低置信点不立案（语音音节/编码伪影高发区）
    if (!c.firedCues.includes('noiseStep') && level === 'low') continue;
    const classification = classify(c, globalInfo);
    findings.push({
      kind: FINDING_KIND.SPLICE,
      timeSec: round(c.timeSec, 6),
      frameIndex: c.frame,
      confidence: level,
      score: c.score,
      cueAgreement: c.firedCues.length,
      cues: roundCues(c.cues),
      rawMetrics: c.raw,
      classification: classification.label,
      reasons: buildReasons(c, globalInfo, classification),
    });
  }

  for (const a of containerInfo.anomalies || []) {
    findings.push({
      kind: FINDING_KIND.CONTAINER_ANOMALY,
      timeSec: 0,
      frameIndex: 0,
      confidence: a.code === 'SAMPLE_RATE_SWITCH' || a.code === 'GAP_BYTES' ? 'high' : 'medium',
      score: null,
      cueAgreement: 0,
      cues: {},
      rawMetrics: a,
      classification: 'container-anomaly',
      reasons: [a.message],
    });
  }

  const globalFindings = [];
  if (globalInfo.resampled) {
    globalFindings.push({
      kind: FINDING_KIND.RESAMPLE_GLOBAL,
      confidence: 'high',
      classification: 'global-resample',
      evidence: globalInfo.evidence,
      reasons: [
        `安静帧高频本底 ${globalInfo.evidence.quietFrameHfFloorDb} dB，低于重采样阈值 ${P.resampleHfFloorDb} dB`,
        `高频带相对全带衰减 ${globalInfo.evidence.hfBandwidthDropDb} dB（阈值 ${P.resampleHfDropDb} dB），带宽在某一奈奎斯特限处塌缩，是先降采样再升采样的典型痕迹`,
        '该特征覆盖全段而非局部，属于整段重采样；其附近的单线索突变按处理伪影处理，不计拼接点',
      ],
    });
  }
  if (globalInfo.reencoded) {
    globalFindings.push({
      kind: FINDING_KIND.REENCODE_GLOBAL,
      confidence: globalInfo.codecPeriodicity.detected ? 'high' : 'medium',
      classification: 'global-reencode',
      evidence: { ...globalInfo.evidence, codecPeriodicity: globalInfo.codecPeriodicity },
      reasons: [
        `谱平坦度变异系数 ${globalInfo.evidence.flatnessCv}，全段谱细节被持续压缩`,
        globalInfo.codecPeriodicity.detected
          ? `检测到与编码帧网格吻合的等间隔谱峰值（${globalInfo.codecPeriodicity.hits}/${globalInfo.codecPeriodicity.checks} 次命中），为重编码周期性伪影`
          : '容器为感知编码格式且谱压缩特征全段一致',
        '编码帧边界处的单线索突变属于重编码假阳性，不作为拼接点立案',
      ],
    });
  }

  findings.sort((a, b) => a.timeSec - b.timeSec || (b.score || 0) - (a.score || 0));
  return {
    findings,
    globalFindings,
    stats: summarize(findings),
    globalProcessing: globalInfo,
  };
}

function classify(c, globalInfo) {
  const spectralOnly = c.firedCues.length === 1 &&
    (c.firedCues[0] === 'spectralFlux' || c.firedCues[0] === 'mfccBreak');
  if (spectralOnly && (globalInfo.reencoded || globalInfo.resampled)) {
    return { kind: FINDING_KIND.SPLICE, label: 'likely-reencode-artifact' };
  }
  // 主证据成立：本底台阶 + 至少一条谱线索印证
  if (c.firedCues.includes('noiseStep') &&
    (c.firedCues.includes('spectralFlux') || c.firedCues.includes('mfccBreak') ||
      c.firedCues.includes('energyBreak'))) {
    return { kind: FINDING_KIND.SPLICE, label: 'multi-cue-splice' };
  }
  if (c.firedCues.includes('noiseStep')) {
    return { kind: FINDING_KIND.SPLICE, label: 'noise-floor-splice' };
  }
  if (c.firedCues.length >= 2) return { kind: FINDING_KIND.SPLICE, label: 'spectral-review' };
  return { kind: FINDING_KIND.SPLICE, label: 'single-cue-review' };
}

function buildReasons(c, globalInfo, classification) {
  const out = [];
  for (const k of c.firedCues) {
    if (k === 'noiseStep') {
      out.push(`${CUE_NAMES[k]}（全局鲁棒 z=${round(c.cues[k], 2)}，绝对台阶=${c.raw.hfNoiseStepDb}dB）同时越过 z 阈值 ${G.cueThreshold} 与绝对门槛 ${P.floorStepAbsoluteDb}dB`);
    } else {
      out.push(`${CUE_NAMES[k]}（全局鲁棒 z=${round(c.cues[k], 2)}）超过阈值 ${G.cueThreshold}`);
    }
  }
  if (classification.label === 'likely-reencode-artifact') {
    out.push('该点仅单谱线索触发，且全段存在重编码/重采样痕迹，优先判定为处理伪影而非拼接');
  }
  if (globalInfo.resampled) out.push('全段存在带宽塌缩（重采样）特征，结论以多线索一致性为准');
  if (out.length === 0) out.push('综合分越界但无单线索超阈，列为人工复核项');
  return out;
}

function roundCues(cues) {
  const out = {};
  for (const [k, v] of Object.entries(cues)) out[k] = round(v, 3);
  return out;
}

function summarize(findings) {
  const splices = findings.filter(f => f.kind === FINDING_KIND.SPLICE);
  return {
    totalFindings: findings.length,
    splicePoints: splices.length,
    high: splices.filter(f => f.confidence === 'high').length,
    medium: splices.filter(f => f.confidence === 'medium').length,
    low: splices.filter(f => f.confidence === 'low').length,
    containerAnomalies: findings.filter(f => f.kind === FINDING_KIND.CONTAINER_ANOMALY).length,
  };
}
