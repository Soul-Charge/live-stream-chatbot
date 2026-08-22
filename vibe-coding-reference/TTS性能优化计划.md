# TTS 性能分析与优化计划

基于 `gpt-sovits-performance-report.md`（2026-08-12）与当前中间件代码的瓶颈分析。

> 范围说明：本分支保留 GPT-SoVITS GPU 推理（PyTorch）路线，所有优化均在该路线内进行，不涉及 Genie-TTS 迁移（属于另一分支）。
> 当前首要目标：**降低显存占用**（直播 + 游戏共存），延迟优化次之。

### 实施状态（2026-08-17 更新）

| 项 | 状态 | 落点 |
| --- | --- | --- |
| V1 显存基线探针 | 已执行（2026-08-16，V3 应用前基线）；V3 后需复测 | `scripts/measure_gpt_sovits_vram.ps1` → `gpt-sovits-vram-baseline.md` |
| V2 配置速赢 | 已生效（`expandable_segments` 已撤回） | `config/*.json`：`cut5`、`maxTextLength=120`；torch 2.0.0 不支持 `expandable_segments`，已从 env 移除 |
| V3 CPU 卸载补丁 | 已应用到 F 盘 GPT-SoVITS；API 可完成模型加载与合成，首次预热约 90~120s；待 V1 显存复测 | `scripts/TTS_cpu_offload_v2pro.patch`、`scripts/apply_TTS_cpu_offload.ps1` |
| A1 启动预热 | 已实现；实测首次预热约 90~120s，`tts.requestTimeoutMs` 已提至 300000ms；当前同步阻塞启动 | `src/index.js` `warmupTts()`，配置 `tts.warmup` |
| A2 端到端流式 | 流式泵已实现并验证槽位时序；但当前 `streamingMode:true` 被后端解释为 `return_fragment`，真实增量流式待评估 `streaming_mode=2/3` | `src/tts.js` `#synthesize/#pumpResponse` |
| A4 结果缓存（临时） | 已实现；按弹幕库计划降级为过渡方案，默认关闭，A5 稳定后移除 | `src/tts.js` 内存 LRU，配置 `tts.cache.enabled=false` |
| A5 高频弹幕预生成文件缓存 | 已纳入计划，作为 A4 的取代方案；弹幕库阶段 1/2 已实现，阶段 3 优先实施 | 见 `vibe-coding-reference/弹幕数据库构建计划.md` |
| B1 内存 watchdog | 已实现（可选） | `src/watchdog.js`，配置 `gptSoVits.watchdog` |
| C 多实例常驻路由 | 继续搁置 | — |
| 语言误判 L2 假名路由 | 已实现并启用：`textLang=all_zh` + `textLangWhenKana=auto` | `src/tts.js` `resolveTextLang()`；见 `vibe-coding-reference/中日文TTS误判根因分析.md`、`中日文TTS误判解决方案.md` |

### 当前运行现状与实测（2026-08-17 补充）

| 项 | 实测/现状 | 结论 |
| --- | --- | --- |
| V3 补丁完整性 | F 盘 `TTS.py` SHA256 与补丁后预期一致；原始备份与状态文件齐全 | 补丁应用无误 |
| V1 显存基线（V3 前） | 启动空闲 4369MB；切换到 ema 后空闲 4960MB；切换+合成峰值 4960MB；结束 5s 后 4801MB | 原版峰值约 4.96GB，高于 3.6~3.7GB 的历史报告；V3 后必须重测 |
| API 冷启动 | 2026-08-17 中间件拉起后约 176s 才监听 9880 | `gptSoVits.startupTimeoutMs` 已提高到 600000ms |
| 切换默认角色权重 | ema 的 `set_gpt_weights` + `set_sovits_weights` 实测约 29s（GPT 约 8.6s、SoVITS 约 20.8s） | 属角色切换成本，预热覆盖不到该段 |
| 首次预热合成 | 后端 `/tts` 返回 200 并跑完，内部计时 `15.852 / 0.001 / 91.720 / 1.571`，约 92s；中间件曾因旧 `requestTimeoutMs=30000` 在 30s 时主动 abort | `tts.requestTimeoutMs` 已提高到 300000ms；本次后端已热，下次启动需重新完整预热 |
| 启动总耗时 | 理想路径 = API 冷启动（约 3 分钟）+ 切换权重（约 30s）+ 预热（约 90~120s），8899 端口在预热完成后才监听 | 当前启动较慢；后续可把预热改后台执行 |
| `streamingMode: true` | 本 GPT-SoVITS 版本中 `True == 1`，被转换为 `streaming_mode=False, return_fragment=True` | 当前无“边生成边播放”收益，A2 首音仍等整段片段生成完 |
| torch 版本 | `runtime` 自带 torch 2.0.0，不支持 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments` | 已从默认 env 移除，中间件会过滤继承值 |
| better-sqlite3 | 当前 `node_modules` 内原生模块为 WSL/Linux 编译，Windows 下报 `not a valid Win32 application` | 数据库自动降级；Windows 需 `npm rebuild better-sqlite3` |
| PowerShell 脚本编码 | 两个 ps1 已保存为 UTF-8 with BOM + CRLF | Windows PowerShell 5.1 下中文不再乱码 |
| 中间件监听端口 | 原 7788 落在系统保留段 `7780-7879`，Windows 报 `EACCES: permission denied`；默认已改为 8899 | 若再遇 EACCES，运行 `netsh interface ipv4 show excludedportrange protocol=tcp` 查排除段并换端口 |

## 0. 硬件约束与显存构成（2026-08-12 补充）

- 显卡：**RTX 2060 6GB**（6144MiB）。TTS 推理峰值 3.6~3.7GB，叠加游戏与 OBS（NVENC）后超出预算。
- 已确认配置：`tts_infer.yaml` 中 `custom` 段 `is_half: true`（fp16 已开启）；`TTS.py` 每次推理结束已在 `finally` 执行 `gc.collect() + torch.cuda.empty_cache()`。**"半精度"与"合成后清缓存"两项常规手段已在用**。
- 启动参数仅 `-c/-a/-p`，无官方低显存开关。

显存构成估算（fp16 常驻权重 + 瞬态）：

| 组成 | 估算 | 可压缩性 |
| --- | ---: | --- |
| CUDA 上下文 / cuDNN workspace（WDDM） | 0.5~0.8GB | 难 |
| RoBERTa-wwm-large（fp16） | ~310MB | 可移 CPU |
| chinese-hubert-base（fp16） | ~90MB | 可移 CPU |
| sv 声纹 eres2net（v2Pro 系特有） | ~50~100MB | 可移 CPU |
| t2s GPT 权重（fp16） | ~150MB | 保留 GPU（延迟敏感） |
| SoVITS v2ProPlus 权重（fp16） | ~165MB | 保留 GPU（延迟敏感） |
| 推理激活 + 分配器占用 | 峰值至 ~2GB | 分句切片可降峰值 |

结论：常驻权重约 0.8~1.0GB 里约一半（BERT/hubert/sv）是"轻负载模块"，可移 CPU；瞬态峰值靠分句切片压低。GPU 利用率仅 21~43%，用"GPU 时间换显存"方向成立。

## 1. 测试报告解读

### 1.1 测试口径

- 每个角色的"总耗时"秒表在调用 `set_gpt_weights` / `set_sovits_weights` **之前**启动，因此总耗时 = 权重加载 + 文本合成 + 音频下载。
- 测试直连 `api_v2.py`，未经过中间件与播放器，反映的是后端纯耗时。
- 测试文本约 20 字，产出音频 234~314KB。按 32kHz / 16bit / 单声道 WAV（约 64KB/s）估算，音频时长约 3.7~4.9s。

### 1.2 关键现象

| 现象 | 数据 | 解读 |
| --- | --- | --- |
| 首角色明显慢 | default 14.0s，后续角色 3.9~5.2s | 冷启动效应：CUDA 上下文初始化、首次推理 warmup、权重首次读盘。启动后第一条弹幕会吃满这 14s |
| GPU 大量空转 | GPU 峰值仅 21~43% | 瓶颈不在算力，而在 CPU 侧文本前端（G2P/BERT 特征）、Python 开销与权重磁盘加载 |
| 内存随切换单调增长 | 工作集 2281→2951MB，私有内存 6562→7323MB，显存 3589→3725MB | 每次切换角色约残留工作集 200~300MB / 私有内存 200~350MB。长时间直播交替角色会持续膨胀 |
| 推理本身不算慢 | 稳态角色总耗时 3.9s ≈ 音频 3.7~4.1s | 扣除切换后纯推理大概率快于实时（RTF<1），有性能余量换显存 |

### 1.3 中间件链路附加问题（报告未覆盖）

1. **流式形同虚设**：配置 `streamingMode: true`，但 `src/tts.js` 用 `await response.arrayBuffer()` 等**整段音频合成完**才交给播放器，首音延迟 = 全部合成耗时。（早期版本曾拿到响应头就透传流，结果前一条还没合成完、下一条就切角色导致出错，才改回整段缓冲——修正设计见 A2。）
2. **无预热**：`src/index.js` 启动时只 `setTtsWeights`，第一条真实弹幕承担全部冷启动成本。
3. **角色交替成本高**：弹幕角色交替时，每条都触发一次权重重载（数秒级），且队列因此被强制串行。
4. **无结果缓存**：复读、固定句式等重复文本每次都重新合成。

## 2. 优化计划

### 阶段 V：显存压缩（本次重点）

- **V1 显存基线测量**：探针脚本已重审并修正：分别采样"启动后空闲（`tts_infer.yaml custom` 模型）/ 切换到默认角色后空闲 / set_weights + 合成窗口峰值 / 合成结束 5s 后"四点；自启动 API 使用临时 `tts_infer.yaml` 副本，复用 API 时备份并恢复其配置，避免 `set_weights` 持久化改写真实配置；API 提前退出时带日志快速失败；采样为空时拒绝写 0 值报告。2026-08-16 已完成 V3 前基线：空闲 4369MB、切换后 4960MB、峰值 4960MB、结束 5s 后 4801MB，见 `gpt-sovits-vram-baseline.md`；V3 应用后需复测。
- **V2 配置速赢（不改代码）**：
  - `config.json` 中 `textSplitMethod: cut0` → `cut5`（按标点分句逐段合成，配合已有 streaming，显著压低长文本激活峰值；短弹幕无感）。
  - ~~启动环境加 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`~~ **已撤回**：本机 GPT-SoVITS 自带 torch 2.0.0，`CUDACachingAllocator::parseArgs` 不认识该选项，会抛 `Unrecognized CachingAllocator option` 导致 API 在加载 t2s 权重时退出。如未来升级到支持该选项的 torch（≥2.1），再重新开启。
  - 可选：`maxTextLength` 200 → 120，直接限制激活峰值上限（长弹幕截断更激进，按接受度决定）。
- **V3 模块级 CPU 卸载补丁（收益最大，预估省 0.5~1GB 常驻 + 部分瞬态）**：
  - 补丁对象 `GPT_SoVITS/TTS_infer_pack/TTS.py`：`bert_model`、`cnhuhbert_model`、`sv_model` 加载到 CPU；特征计算处输入 `.to('cpu')`、输出 `.to(cuda)` 回传。
  - 代价：稳态估计每条弹幕 +150~350ms（短文本 BERT CPU 约 50~200ms，hubert/sv 约 50~150ms），RTF 余量可吸收。但**冷启动首次合成实测约 90~120s**：BERT CPU 首次推理约 30s、参考音频与 t2s 首次推理等合计 90s+；该成本由 A1 预热承担，不计入稳态首音。
  - GPU 只保留 t2s + vits（合成主力）。预期峰值 3.6GB → 2.0~2.5GB，空闲保持 → ~1.2~1.5GB。
  - 补丁用 diff 文件保存（放 `scripts/` 或 `vibe-coding-reference/`），GPT-SoVITS 升级后重打。
  - 应用脚本已重审并修正：不再依赖 PATH 中的 `git`，改为解析 unified diff 逐 hunk 校验并替换；内置已知原始/补丁后 SHA256，回滚前校验当前文件与备份，防止误覆盖；新增 `-DryRun` 与状态文件；版本不匹配时中止并提示。
- **V4 备选（最后手段）**：v2ProPlus → v2 模型重训（底模更小），质量换资源；工作量大，仅当 V2+V3 仍不够时考虑。

### 阶段 A：延迟优化（次要，显存达标后做）

- **A1 启动预热**：`src/index.js` 在 `setTtsWeights` 后用默认角色合成一条极短文本并丢弃，把冷启动从首条弹幕挪到启动阶段。实测 V3 后的首次预热约 90~120s，`tts.requestTimeoutMs` 已相应提高到 300000ms（5 分钟）；当前 `main()` 会在预热完成后才 `server.listen`，所以 8899 端口要等约 90~120s。预热失败不会阻断中间件启动，但首条真实弹幕会变慢。后续可选：把预热改到后台，先监听后预热。
- **A2 端到端流式（需谨慎，历史上踩过坑）**：
  - **历史故障**：早期版本 `fetch` 拿到响应头就把流交给播放器并释放 TTS 队列槽位，导致前一条音频还在服务器生成时，下一条任务已开始执行 `setTtsWeights` 切换角色，进行中的合成被破坏报错。这是改回 `arrayBuffer()` 整段缓冲的原因——它无意中充当了同步屏障。
  - **必须守住的不变量**：TTS 队列槽位持有到"**服务器生成结束**"（响应流读完），而不是"拿到流"；但不需要持有到"播放结束"（否则合成无法与播放并行，吞吐倒退）。
  - **安全设计**：`#synthesize` 内部起泵循环，把 `response.body` 尽快读入一个 `PassThrough`（`highWaterMark` 设大，如 16MB，避免反压卡住网络读取；200 字弹幕音频约 ≤2.5MB，不会真的占满），立即把 PassThrough 交给播放队列拿首块即播的收益；任务 Promise 等到**源流读完**才 resolve，槽位恰好持有整个生成过程。
  - **语义确认**：合成 N+1 仍可与 N 的播放并行（与现状一致），但不允许与 N 的生成并行；角色切换只发生在槽位空闲时，天然安全。请求超时计时器覆盖到泵读完为止。
  - **验证要点**：连续两条不同角色弹幕（第二条必须等第一条生成完才切权重，日志可观察）；长文本首音 <1s；ffplay 对占位 WAV 头（data size 为 0xFFFFFFFF）的兼容性。
- **A4 结果缓存（过渡方案，将被 A5 取代）**：
  - 已实现的内存 LRU 只作为 A5 文件缓存落地前的临时兜底，**默认关闭**（`tts.cache.enabled=false`），避免在 Node 堆中长期驻留整段 WAV Buffer。
  - 依据 `vibe-coding-reference/弹幕数据库构建计划.md`，结果缓存统一收敛到 A5：SQLite `tts_audio_cache` 索引 + `data/tts-cache/` WAV 文件，播放用 `createReadStream` 流式读取，不再需要中间件进程持有音频字节。
  - A5 阶段 3 稳定并验收后，从 `TTSEngine` 删除内存 LRU（`#cache/#cacheGet/#cacheSet`），配置只保留 `tts.cache.disk.*`；`tts_status` 中的 `cache_hit` 保留为历史状态兼容，新命中统一记 `disk_cache_hit`。
  - 过渡期如仍需一级缓存，也只允许极小容量（如 `maxEntries=4`、`maxBytes=4MB`）且必须显式打开，不作为默认行为。

- **A5 高频弹幕缓存（取代 A4，依赖弹幕库）**：
  - 由弹幕库按可配置规则（如 `24h/10次`、`1h/5次`）统计高频弹幕，写入 `hot_danmaku` 表。
  - WebUI 触发生成/重新生成音频；音频写入 `data/hot-danmaku/<role_comment>/<speech_hash>.wav`，`audio_path` 回填到 `hot_danmaku` 表。
  - 之后收到相同弹幕时，中间件先查 `hot_danmaku`：匹配到已生成音频则直接播放，未命中才请求后端；重启后仍可命中。A4 内存 LRU 不再是命中路径。
  - 目标：热句首音延迟 < 0.5s（含重启后），缓存命中率可量化，同时把 A4 的整段 WAV Node 堆占用降为文件缓存的小额流缓冲。详细设计见 `vibe-coding-reference/高频弹幕缓存机制计划.md`。

### 阶段 B：稳定性缓解

- **B1 内存膨胀对策**：直播前重启推理 API；或加 watchdog 在私有内存超阈值时自动重启后端（利用现有 `ensureTtsApi` 拉起机制）。
- **B2 在场角色收敛**：配置侧保持角色表精简，减少切换次数。

### 阶段 C：多实例常驻路由（**6GB 显存下搁置**）

多实例每实例需 ~3.6GB 显存，RTX 2060 无法承受，本方案搁置。若 V3 后单实例峰值 ≤2.5GB，可重新评估"双实例"（主角色常驻 + 共享切换实例）。

## 3. 验收指标

| 指标 | 当前基线 | 目标 |
| --- | --- | --- |
| **TTS 显存峰值** | V1 实测 4960MB（V3 前）；历史报告 3.6~3.7GB | ≤ 2.5GB（V3 后待复测） |
| **TTS 空闲显存保持** | V1 实测 4369MB（V3 前） | ≤ 1.5GB（V3 后待复测） |
| 稳态首音延迟（同角色） | 约 4s（整段缓冲） | < 1.5s（含 CPU 卸载附加耗时） |
| 启动后首条弹幕延迟 | 原约 14s；V3 冷启动首次约 90~120s | A1 成功后 < 3s；A1 本身耗时允许 90~120s |
| 内存随角色切换漂移 | +200~350MB/次 | 直播一场不触发 OOM（B1 兜底） |

## 4. 优先级建议

1. **V1 测量**：V3 前基线已拿到（峰值 4960MB）；下一步是 V3 应用后复测，确认 CPU 卸载的实际收益。
2. **V2 配置速赢**：cut5 + 分配器 env，零风险立即生效。
3. **V3 CPU 卸载补丁**：显存收益最大，接受 +150~350ms/条的延迟代价。
4. B1 watchdog：直播稳定性兜底。
5. A1 预热 / A2 流式：已实现；下一步评估“后台预热”和 `streaming_mode=2/3`；A4 仅作过渡且默认关闭。
6. 弹幕库阶段 1~2 已落成，**优先实施 A5 文件缓存与热句预生成**，验收后移除 A4；词云/观众图谱属于弹幕库阶段 4，不占用 TTS 优化主线。