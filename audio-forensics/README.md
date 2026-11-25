# 音频完整性校验台（Audio Forensics Workbench）

纯前端、全程本地运行的音频取证工作台。文件不离开浏览器，无任何网络请求；用于判断现场录音
**哪一段时间被剪辑/拼接**，并以哈希链固定证据保管过程、输出可复算的 JSON 报告。

## 运行

```bash
# 任意静态服务器即可，无需构建
node tests/serve.mjs        # http://127.0.0.1:8731
# 或：python3 -m http.server 8000
```

浏览器要求：支持 ES Module、Web Worker、IndexedDB、Web Crypto；MP3 解码优先用
**WebCodecs（AudioDecoder）**，不支持时降级到 WebAudio `decodeAudioData`（报告中会标注 fallback）。

## 五个页面

| 路由 | 页面 | 职责 |
| --- | --- | --- |
| `#/import` | 证据导入 | 拖拽/选择文件，按**魔数**识别 WAV/MP3，计算 SHA-256，写入保管链首条 |
| `#/detect` | 篡改检测 | Worker 分块分析，输出带时间戳、置信度、线索依据的疑点列表与全局处理结论 |
| `#/timeline` | 时间线 | 峰值包络波形 + 疑点标记，点击/滚轮缩放定位，单帧线索明细 |
| `#/custody` | 保管链 | 哈希链可视化、逐条校验、内置“改写一条即断链”篡改演示 |
| `#/report` | 报告 | **JSON 为权威完整记录**，PDF 仅为打印视图；导出动作全部登记保管链 |

## 需求落点

1. **容器结构解析，不靠文件名**
   - WAV：`js/containers/wav.js` 校验 RIFF/WAVE 魔数，遍历全部 chunk（含 LIST 嵌套），
     检查 fmt 自洽性、重复 chunk、尾随数据、RIFF 长度篡改。
   - MP3：`js/containers/mp3.js` 解析 ID3v2/ID3v1、逐帧扫描 MPEG 同步字与帧头，
     统计码率/采样率/声道切换、帧间空隙（gap bytes）、XING/VBR 头。
   - 统一入口 `detectContainer()` 只看字节魔数；无法识别时拒绝按扩展名猜测。

2. **背景噪声连续性 + 频谱断点找拼接，给时间戳与置信度**（`js/core/detection.js`）
   - 主证据：取全段最安静 20% 帧，在 **±1s 长窗**内比较两侧高频本底（4–7.5kHz，语音能量弱、
     环境本底差异最明显）的中值台阶；需同时越过全局鲁棒 z 阈值与 **3dB 绝对门槛**。
   - 谱线索：梅尔谱通量、MFCC 断点、过零率突变、帧能量断点，全部做**全局 MAD 鲁棒标准化**。
   - 非极大值抑制 + 最小间隔合并，输出 high/medium/low 三级置信度与每条判定依据。

3. **保管链哈希串联，改一条即被发现**（`js/core/custody.js`）
   - 每条记录的 `entryHash = SHA256(规范化字段 + prevHash)`， genesis 为 64 个 0。
   - 校验覆盖：内容哈希、prevHash 链接、序号连续/重复；删除、重排、改写任一条都会断链并定位序号。
   - 导入、分析、每次 JSON/PDF 导出、人工校验均落链，持久化在本机 IndexedDB。

4. **区分重采样/重编码，抑制假阳性**
   - 重采样：先降后升会在原奈奎斯特限处造成**高频本底深度塌缩**（实测干净 −14dB、重采样 −38dB），
     该特征全段持续，单独归类为全局 `resample` 结论，不立局部拼接案。
   - 重编码：谱平坦度变异系数偏低 + MP3 编码帧网格的等间隔谱峰周期性，归类为全局 `reencode`；
     仅单谱线索触发且全局存在处理痕迹的边界标记为 `likely-reencode-artifact`。
   - 干净样例零高置信拼接由自动化测试守护。

5. **数小时录音分块处理，不卡死页面**
   - WAV PCM 按 2 秒/块流式读取（`decodeWavStream`），MP3 按编码帧经 WebCodecs 流式解码；
   - 分析在 **Web Worker** 内进行，特征提取按 `chunkFrames` 分批并让出事件循环，持续回报进度；
   - 环形缓冲只保留帧重叠区，波形降采样到 ≤1600 点，内存占用取决于块大小而非录音总时长。
   - 实测 1 小时 / 151MB WAV：约 29s 完成、15.5 万帧、JS 堆稳定在数百 MB 内。

6. **JSON 完整记录，PDF 仅展示**
   - `js/core/report.js`：报告含容器结构、全部分析参数、每疑点原始线索指标、全局结论、完整保管链。
   - JSON 用**键序固定的规范化序列化**，`analysisHash` 覆盖文件哈希+容器+参数+全部疑点。
   - PDF 走浏览器打印视图（`@media print`），不承载证据效力。

7. **同录音同参数 → 同疑点列表（确定性）**
   - 无随机数、无 `Date.now/Math.random` 参与计算；FFT、重采样（线性插值）、鲁棒统计、
     NMS、阈值与权重全部固定在 `js/core/constants.js`，并写入报告 `analysisParameters`。
   - 两次分析的 `analysisHash` 与疑点 JSON 必须逐字段一致（有自动化与 E2E 测试守护）。

## 目录结构

```
js/
  core/        参数、工具、纯JS SHA-256、检测引擎、保管链、报告、IndexedDB、状态层
  containers/  WAV(RIFF) 与 MP3(MPEG/ID3) 结构解析（魔数驱动）
  decoders/    WAV 流式 PCM、MP3 WebCodecs/WebAudio 解码
  dsp/         FFT、确定性重采样、梅尔滤波与逐帧特征
  workers/     analyze-worker.js 分块编排
  ui/          哈希路由 + 五个页面
tests/         Node 单测、样例生成、CDP 端到端、长时长测试、静态服务器
samples/       合成测试样例（pristine/spliced/resampled/reencoded/容器异常）
```

## 测试

```bash
node tests/make-samples.mjs           # 用 ffmpeg 生成合成样例
node --test tests/*.test.mjs          # 15 项 Node 单测（哈希/保管链/容器/检测/可复现）

# 浏览器端到端（需要本机 Chrome）：
node tests/serve.mjs &
# 以 --remote-debugging-port=9222 启动 headless Chrome 后：
node tests/e2e-cdp.mjs                # 18 项真实浏览器断言，含零网络请求校验

RUN_LONG=1 node tests/long-duration.mjs   # 1 小时文件稳定性（需先生成 long-1h.wav）
```

## 取证边界（如实说明）

- 检测结论是**疑点（finding）而非法律结论**：置信度表达多线索一致程度，最终需人工复核。
- 纯前端 SHA-256 与 Node `crypto`、Web Crypto 结果一致（有测试），但本机环境的可信度不在应用控制范围内。
- 极度干净、零本底噪声的合成信号，或两次拼接段本底几乎相同的高级剪辑，可能降低噪声台阶线索灵敏度；
  此时以谱断点多线索一致性与容器异常作为补充证据。
