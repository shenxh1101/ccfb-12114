// 长时长稳定性测试（默认跳过，需先 ffmpeg 生成 samples/long-1h.wav，并用 RUN_LONG=1 开启）：
// 验证数小时录音分块流式处理不卡死、内存不随时长膨胀、进度持续回报。
// 运行：先 node tests/serve.mjs 与带 9222 远程调试的 Chrome，再 RUN_LONG=1 node tests/long-duration.mjs
import { once } from 'node:events';

if (process.env.RUN_LONG !== '1') {
  console.log('跳过长时长测试（设置 RUN_LONG=1 启用，需要 samples/long-1h.wav 与运行中的 Chrome 9222）');
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
await once(ws, 'open');
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(m.error) : resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id; pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8731/index.html' }); await sleep(1200);

const r = await send('Runtime.evaluate', {
  expression: `(async()=>{
  const resp = await fetch('/samples/long-1h.wav');
  const file = new File([await resp.blob()],'long-1h.wav',{type:'audio/wav'});
  const store = await import('/js/core/store.js');
  const t0 = performance.now();
  const imp = await store.importEvidence(file);
  const tImport = performance.now()-t0;
  let progressCalls=0;
  const t1=performance.now();
  const rec = await store.runAnalysis(imp.evidence, ()=>{progressCalls++;});
  const tAnalyze = performance.now()-t1;
  return { fileMB: Math.round(file.size/1048576), tImportMs: Math.round(tImport), tAnalyzeMs: Math.round(tAnalyze),
    progressCalls, frames: rec.featureMeta.analysisFrames, durationSec: rec.featureMeta.durationSec,
    waveformPoints: rec.waveform.peakEnv.length,
    mem: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null };
})()`, awaitPromise: true, returnByValue: true,
});
if (r.exceptionDetails) { console.error('EXC', r.exceptionDetails.exception?.description); process.exit(1); }
const v = r.result.value;
console.log(JSON.stringify(v, null, 2));
let fail = 0;
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) fail++; };
check('分析在 120s 内完成', v.tAnalyzeMs < 120000);
check('进度持续回报（>100 次）', v.progressCalls > 100);
check('帧数与 1 小时时长匹配（>15 万帧）', v.frames > 150000);
check('波形被降采样到 ≤1600 点', v.waveformPoints <= 1600);
check('JS 堆占用 <300MB（不随 151MB 文件整体驻留）', v.mem === null || v.mem < 300);
ws.close();
process.exit(fail ? 1 : 0);
