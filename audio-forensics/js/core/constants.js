// 全局分析参数 —— 全部固定，保证同一份录音、同样参数产生完全一致的疑点列表
// 任何参数调整都会进入报告的 analysisParameters，并参与 analysisHash。
export const ANALYSIS_PARAMS = Object.freeze({
  specVersion: 'AF-1.0.0',
  sampleRateTarget: 22050,        // 统一重采样到该速率再分析（确定性线性插值）
  frameSize: 2048,                // 分析帧长（目标采样率下，约 92.9ms）
  hopSize: 512,                   // 帧移（约 23.2ms）
  melBands: 40,
  fMin: 30,
  fMax: 8000,
  noiseBandHz: [60, 300],         // 低频能量带（参考）
  hfNoiseBandHz: [4000, 7500],    // 高频环境本底噪声带：语音能量弱，本底差异最能暴露拼接
  quietFrameRatio: 0.2,           // 估计本底时取最安静的 20% 帧
  robustK: 8,                     // 鲁棒统计的局部 MAD 窗口半径（备用）
  boundaryWindow: 6,              // 短窗口：能量/瞬态类线索（约 ±0.14s）
  floorWindowSec: 1.0,            // 长窗口：安静帧本底台阶（保证两侧安静帧样本充足）
  floorMinQuietFrames: 3,         // 长窗口每侧至少安静帧数，不足则该边界不评本底线索
  nmsRadiusSec: 0.12,             // 非极大值抑制半径（秒）
  minGapSec: 0.25,                // 两个独立疑点的最小间隔
  // 全局鲁棒 z：在“全部分界跳变”的总体分布上做 MAD 标准化，避免局部窗口把真台阶自适应掉
  globalZ: Object.freeze({
    cueThreshold: 3.0,            // 单线索确认阈值
    confidence: Object.freeze({ high: 5.0, medium: 3.25, low: 2.25 }),
  }),
  // 各线索在综合分中的权重（噪声本底台阶为主证据，权重最高）
  weights: Object.freeze({
    noiseStep: 0.42,
    spectralFlux: 0.22,
    mfccBreak: 0.16,
    zeroRate: 0.07,
    energyBreak: 0.13,
  }),
  // 线索确认阈值（鲁棒 z 分数，局部线索保留兼容）
  cueThreshold: 3.5,
  // 综合置信度映射分位（相对整段的鲁棒 z 分数）
  confidence: Object.freeze({ high: 6.0, medium: 4.0, low: 2.75 }),
  // 本底台阶的绝对 dB 门槛：真实拼接的环境本底差异通常 >3dB，语音波动 <1.5dB
  floorStepAbsoluteDb: 3.0,
  // 全局重采样/重编码判定
  // 重采样（先降后升）在奈奎斯特限以上能量深度塌缩：高频本底极低即判据
  resampleHfFloorDb: -28,         // 安静帧高频本底低于此值 → 疑似带宽受限/重采样
  resampleHfDropDb: 18,           // 高频带相对全带能量低出此 dB 数 → 带宽塌缩
  resampleFlatnessCv: 0.18,       // 谱平坦度变异系数低于此值 → 疑似重编码（辅助）
  mp3PeriodicityMinHits: 6,       // 编码器周期性命中帧数
  // 分块处理
  chunkFrames: 4096,             // 每次调度处理的帧数（让出主线程/Worker 事件循环）
});

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

export const FINDING_KIND = Object.freeze({
  SPLICE: 'splice',                 // 疑似拼接点
  RESAMPLE_GLOBAL: 'resample',      // 整段重采样痕迹（解释性，不计拼接）
  REENCODE_GLOBAL: 'reencode',      // 整段重编码痕迹（解释性）
  CONTAINER_ANOMALY: 'container',   // 容器结构异常
});

export const CONTAINER_FORMAT = Object.freeze({
  WAV: 'audio/wav',
  MP3: 'audio/mpeg',
  UNKNOWN: 'application/octet-stream',
});
