// 验证纯算法模块的导入图在 Node 下完整可加载（UI/Worker 依赖浏览器全局，单独静态检查）
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('核心算法模块导入图完整', async () => {
  const mods = [
    '../js/core/constants.js', '../js/core/util.js', '../js/core/sha256.js',
    '../js/core/detection.js', '../js/core/custody.js', '../js/core/report.js',
    '../js/dsp/fft.js', '../js/dsp/resample.js', '../js/dsp/features.js',
    '../js/containers/wav.js', '../js/containers/mp3.js',
    '../js/decoders/wav-decoder.js',
  ];
  for (const m of mods) {
    const mod = await import(m);
    assert.ok(mod, m);
  }
});
