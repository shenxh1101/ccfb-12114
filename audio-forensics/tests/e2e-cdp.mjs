// 真实浏览器端到端测试（Chrome DevTools Protocol）：
// 加载页面 → 注入样例文件 → 走真实 Worker 分析 → 校验检测/保管链/可复现性/零网络请求。
// 运行前需：node tests/serve.mjs 起在 8731，Chrome 远程调试在 9222。
import { readFileSync } from 'node:fs';
import { once } from 'node:events';

const BASE = 'http://127.0.0.1:8731/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpConnect() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await once(ws, 'open');
  let id = 0;
  const pending = new Map();
  const eventListeners = [];
  // 单一消息分发器：响应按 id 寻址，事件广播给订阅者，避免多监听器吞消息
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of eventListeners) fn(msg);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const onEvent = fn => eventListeners.push(fn);
  return { send, onEvent, ws };
}

async function evaluate(cdp, expression) {
  // 包成异步 IIFE；表达式若是语句块，需自带 return（见各调用点）
  const wrapped = expression.trim().startsWith('{') || /;\s*$/.test(expression)
    ? `(async () => { ${expression} })()`
    : `(async () => { return ( ${expression} ); })()`;
  const r = await cdp.send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}

const cdp = await cdpConnect();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Network.enable');
const networkRequests = [];
cdp.onEvent(m => {
  if (m.method === 'Network.requestWillBeSent') networkRequests.push(m.params.request.url);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('  [console.error]', m.params.args.map(a => a.value || a.description).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('  [exception]', m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description || '');
  }
});

console.log('1) 加载应用页面');
await cdp.send('Page.navigate', { url: BASE });
await sleep(2500);
const title = await evaluate(cdp, 'document.querySelector(".brand-title")?.textContent');
check('页面渲染', title === '音频完整性校验台', String(title));

// 把样例文件字节注入浏览器，构造 File 对象
function injectFile(varName, buf, fileName, mime) {
  const b64 = buf.toString('base64');
  return `
    (() => {
      const bin = atob(${JSON.stringify(b64)});
      const u8 = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      globalThis.${varName} = new File([u8], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mime)} });
      return globalThis.${varName}.size;
    })()`;
}

console.log('2) 导入拼接样例（WAV）并触发真实分析');
const splicedWav = readFileSync('samples/spliced.wav');
await evaluate(cdp, injectFile('fSplice', splicedWav, 'spliced.wav', 'audio/wav'));
await evaluate(cdp, `
  const store = await import('/js/core/store.js');
  globalThis.__store = store;
  globalThis.__imp = await store.importEvidence(globalThis.fSplice);
  globalThis.__ev = globalThis.__imp.evidence;
  globalThis.__rec1 = await store.runAnalysis(globalThis.__ev, () => {});
  return 'ok';
`);
const stats1 = await evaluate(cdp, 'globalThis.__rec1.analysisResult.stats');
console.log('   检测统计:', JSON.stringify(stats1));
check('WAV 检出拼接疑点', stats1.splicePoints >= 1, JSON.stringify(stats1));
check('存在高/中置信点', stats1.high + stats1.medium >= 1);
const spliceTimes = await evaluate(cdp, 'globalThis.__rec1.analysisResult.findings.filter(f=>f.kind==="splice").map(f=>f.timeSec)');
check('拼接点时间戳在 6s 附近', spliceTimes.some(t => Math.abs(t - 6) < 0.8), JSON.stringify(spliceTimes));
const decoder = await evaluate(cdp, 'globalThis.__rec1.decodeInfo.decoder');
console.log('   解码器:', decoder);

console.log('3) 可复现性：同文件再分析，指纹必须一致');
const rec2 = await evaluate(cdp, `
  const r2 = await globalThis.__store.runAnalysis(globalThis.__ev, () => {});
  return { hash1: globalThis.__rec1.analysisHash, hash2: r2.analysisHash,
     same: JSON.stringify(globalThis.__rec1.analysisResult.findings) === JSON.stringify(r2.analysisResult.findings) };
`);
check('两次分析指纹一致', rec2.hash1 === rec2.hash2, `${rec2.hash1} vs ${rec2.hash2}`);
check('疑点列表逐字段一致', rec2.same === true);

console.log('4) 保管链：导入/分析事件串接且校验通过，篡改可被发现');
const chain = await evaluate(cdp, `
  const custody = await import('/js/core/custody.js');
  const entries = await globalThis.__store.getChain(globalThis.__ev.evidenceId);
  const verify = custody.verifyChain(entries);
  const cloned = entries.map(e => ({...e, detail:{...e.detail}}));
  cloned[0].fileHash = 'x' + cloned[0].fileHash.slice(1);
  const tampered = custody.verifyChain(cloned);
  return { count: entries.length, ok: verify.ok, tamperDetected: !tampered.ok, brokenSeq: tampered.firstBrokenSeq };
`);
check('保管链含导入+两次分析', chain.count >= 3, String(chain.count));
check('保管链校验通过', chain.ok === true);
check('改写一条即被发现并定位序号', chain.tamperDetected === true && chain.brokenSeq === 0, JSON.stringify(chain));

console.log('5) 干净样例零高置信 + 重采样样例给全局解释');
const pristine = readFileSync('samples/pristine.wav');
await evaluate(cdp, injectFile('fClean', pristine, 'pristine.wav', 'audio/wav'));
const cleanRes = await evaluate(cdp, `
  const imp = await globalThis.__store.importEvidence(globalThis.fClean);
  const rec = await globalThis.__store.runAnalysis(imp.evidence, () => {});
  return { high: rec.analysisResult.stats.high, splices: rec.analysisResult.stats.splicePoints };
`);
check('干净样例无高置信拼接', cleanRes.high === 0, JSON.stringify(cleanRes));

const resampled = readFileSync('samples/resampled.wav');
await evaluate(cdp, injectFile('fRs', resampled, 'resampled.wav', 'audio/wav'));
const rsRes = await evaluate(cdp, `
  const imp = await globalThis.__store.importEvidence(globalThis.fRs);
  const rec = await globalThis.__store.runAnalysis(imp.evidence, () => {});
  return rec.analysisResult.globalFindings.some(g => g.kind === 'resample');
`);
check('重采样样例产生全局 resample 结论', rsRes === true);

console.log('6) MP3 样例走浏览器解码（WebCodecs 或 WebAudio 降级）');
const mp3 = readFileSync('samples/spliced.mp3');
await evaluate(cdp, injectFile('fMp3', mp3, 'spliced.mp3', 'audio/mpeg'));
const mp3Res = await evaluate(cdp, `
  const imp = await globalThis.__store.importEvidence(globalThis.fMp3);
  const rec = await globalThis.__store.runAnalysis(imp.evidence, () => {});
  return { decoder: rec.decodeInfo.decoder, fallback: rec.decodeInfo.fallback,
     fmt: rec.container.detectedFormat, frames: rec.featureMeta.analysisFrames,
     splices: rec.analysisResult.stats.splicePoints };
`);
console.log('   MP3 解码路径:', mp3Res.decoder, mp3Res.fallback || '');
check('MP3 魔数识别为 audio/mpeg', mp3Res.fmt === 'audio/mpeg');
check('MP3 成功解码出分析帧', mp3Res.frames > 100, String(mp3Res.frames));

console.log('7) 报告：JSON 完整且 analysisHash 写入');
const report = await evaluate(cdp, `
  const r = await globalThis.__store.buildEvidenceReport(globalThis.__ev, globalThis.__rec1);
  return { schema: r.reportSchema, hash: r.integrity.analysisHash,
     hasFindings: Array.isArray(r.detection.findings), chainEntries: r.custody.entryCount,
     networkCalls: r.tool.networkCalls };
`);
check('报告 schema 正确', report.schema === 'AF-REPORT-1.0');
check('报告含分析指纹', report.hash && report.hash.length === 64);
check('报告含保管链', report.chainEntries >= 1);

console.log('8) 全程零网络请求（本地解析）');
await sleep(500);
const external = networkRequests.filter(u => !u.startsWith('http://127.0.0.1:8731') && !u.startsWith('data:'));
check('无任何外部网络请求', external.length === 0, external.join(','));
check('工具自报 networkCalls=0', report.networkCalls === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
cdp.ws.close();
process.exit(fail ? 1 : 0);
