# 弹幕中日文 TTS 误判：解决方案

> 状态：方案文档，不包含已落地的代码/配置改动。
> 前置报告：`vibe-coding-reference/中日文TTS误判根因分析.md`
> 目标：在“当前直播弹幕以中文为主、角色音色为日语参考音、偶尔出现日文/英文/数字”的场景下，消除“中文被按日语朗读”和“中文 + 字母/数字混合被按日语合成”的问题，同时尽量保留真日文弹幕的正常朗读。

---

## 1. 目标与非目标

### 1.1 目标

1. 纯中文弹幕稳定走中文前端（G2PW/pypinyin），不再出现日语音读/训读。
2. 中文 + 数字、中文 + 字母 + 数字的弹幕稳定按“中文 + 英文/数字”规则朗读。
3. 含假名的真日文弹幕仍能走日文或中日分段路径，不被全局中文策略破坏。
4. 方案可回滚、可验证，不增加 GPU/内存成本，不明显增加推理延迟。
5. 优先在不改动 GPT-SoVITS 第三方代码的前提下解决问题；引擎补丁只作为可选增强。

### 1.2 非目标

- 不解决“汉字无假名的纯日文短语”（如 `大丈夫`、`本当`）在中文直播间的歧义；这类输入中日文本身不可靠地区分，需要业务默认值或词表，不在本期强制解决。
- 不调整音色、参考音频、声学模型。
- 不重做 GPT-SoVITS 语种识别器。
- 不改变现有数据库、播放器、角色切换机制。

---

## 2. 方案总览

推荐采用 **“中间件语言策略 + 配置切换”为主，引擎最小补丁为可选增强**：

| 层级 | 措施 | 作用 | 风险 |
| --- | --- | --- | --- |
| L1 立即缓解 | 把 `config.json` 的 `tts.textLang` 从 `auto` 改为 `all_zh` | 纯中文、中文+数字、中文+字母全部稳定走中文路径；英文仍由 `full_en` 保留为英文 | 纯假名日语弹幕会走中文路径，变成静音/只剩汉字（见 6.1） |
| L2 推荐方案 | 在中间件增加“假名检测路由”：含假名 → `auto`，不含假名 → `all_zh` | 保留真日文弹幕的正常朗读，同时修复 90%+ 的中文弹幕 | 需要少量 `src/tts.js` 代码和配置字段；逻辑简单，回滚容易 |
| L3 可选引擎增强 | 给引擎 `auto` 分支增加“无假名的 `ja` 片段回退为 `zh`”的最小补丁 | 即使以后仍使用引擎原生 `auto`，中文短片段也不会进入 pyopenjtalk | 需要维护第三方补丁文件；仅当继续使用 `auto` 混合模式时才有必要 |
| L4 长期可选 | 修复 `split_lang` 的 `_get_languages()` 结果未写回、候选语言侧边合并过宽等问题 | 从根上改善引擎 auto 检测质量 | 改动第三方库、升级会覆盖，收益低于 L1/L2 |

推荐实施顺序：**L1 → L2 →（视日语弹幕比例决定是否做 L3）**。L4 不作为本期内容，仅记录在案。

---

## 3. 为什么这样解决

### 3.1 `all_zh` 是当前场景下最稳的引擎语言参数

根据根因报告中的实际模块验证：

| 输入 | 当前 `auto` | `all_zh`（引擎实际逻辑） |
| --- | --- | --- |
| `真好听` | `ja`，日语音读 | `zh`，中文拼音 |
| `双厨狂喜` | `ja`，日语音读 | `zh`，中文拼音 |
| `这个BGM真好听` | `zh / en / ja` | `zh / en / zh` |
| `up主声音好好听` | `en / ja` | `en / zh` |
| `LIO八P` | `en / ja / en`，`八` 读 hachi | `en / zh / en`，`八` 读 bā |
| `NTE零` | `en / ja`，`零` 读 rei | `en / zh`，`零` 读 líng |
| `真好听666` | 整段 `ja`，数字日文读法 | 整段 `zh`，数字中文读法 |
| `中文abc混合123，真好听` | `zh / en / zh / ja` | `zh / en / zh / zh` |

`all_zh` 在引擎中的处理是 `LangSegmenter.getTexts(text, "zh")`：所有非英文片段默认按中文，只有 `full_en` 命中的纯 ASCII 字母/数字片段保留为英文。这正好匹配当前弹幕“中文为主、夹杂英文/数字”的语言结构。

### 3.2 仅靠 `all_zh` 会牺牲真日文

实测 `all_zh` 下：

- `こんにちは` 会被标成 `zh`，中文前端 `clean_text` 返回空文本 / 空音素，实际表现接近静音；
- `大丈夫`（无假名）会被读成中文“dà zhàng fū”；
- `主播はかわいい` 会变成 `zh`，最终只剩 `主播`，假名被中文前端过滤。

因此如果直播间确有日文弹幕，`all_zh` 不能单独使用，必须配 L2 假名路由。

### 3.3 假名是最可靠的日文信号

对含假名文本，引擎 `auto` 表现较好：

| 输入 | 引擎 `auto` 实际分段 |
| --- | --- |
| `こんにちは` | `ja` |
| `这是テストです` | `zh 这是` / `ja テストです` |
| `主播はかわいい` | `zh 主播` / `ja はかわいい` |
| `日本語OK` | `ja 日本語` / `en OK` |

所以路由规则定为：

- 文本包含平假名/片假名/半角假名/`々` → 使用 `auto`；
- 否则 → 使用 `all_zh`。

该规则不需要加载任何语言模型，纯正则即可完成，延迟可忽略。

---

## 4. L1 立即缓解方案（只改配置）

### 4.1 改动内容

修改 `config/config.json`：

```json
"tts": {
  "textLang": "all_zh",
  "promptLang": "ja",
  "textSplitMethod": "cut5",
  ...
}
```

同时修改 `config/config.example.json` 对应字段，保持示例一致。

### 4.2 不改动的内容

- `promptLang` 保持 `ja`：参考音频文本是日文，该字段与目标文本语言无关。
- `textSplitMethod` 保持 `cut5`：`all_zh` 后每个分句都强制走中文路径，cut5 不再影响语种判定；保留 cut5 有利于控制显存峰值。
- `config/replacements.json` 暂不删除：`all_zh` 下 `NTE零`、`LIO八P` 会按“英文 + 中文单字”朗读，与现有替换意图兼容；是否清理留到验证阶段决定。

### 4.3 生效方式

- `config.json` 由 `ConfigStore` 监听并热重载，`src/tts.js` 每次合成都从最新配置读取 `tts.textLang`，因此改完配置保存后即可生效，不需要重启中间件。
- 若中间件与后端 API 同时重启过，`warmup` 文本 `测试。` 也会按 `all_zh` 合成，无影响。

### 4.4 验证清单

保存配置后，按顺序用 GET 测试并听音：

```text
真好听
双厨狂喜
这个BGM真好听
up主声音好好听
LIO八P
NTE零
真好听666
中文abc混合123，真好听
```

期望：全部按中文朗读，英文缩写仍按英文拼读，数字按中文数字朗读，不再出现日语音读。

### 4.5 回滚

把 `tts.textLang` 改回 `auto` 即完全回滚，无需动其他配置。

---

## 5. L2 推荐方案：中间件假名路由

在 L1 基础上，保留真日文弹幕支持。只改中间件，不碰引擎。

### 5.1 新增配置字段

建议在 `tts` 下新增一个字段：

```json
"tts": {
  "textLang": "all_zh",
  "textLangWhenKana": "auto",
  ...
}
```

语义：

- `textLang`：默认目标语言（当前推荐 `all_zh`）；
- `textLangWhenKana`：文本中检测到假名时使用的语言（推荐 `auto`，也可配置 `ja` 或 `all_ja`）；为空字符串表示关闭假名路由，完全按 `textLang`。

`src/config.js` 的 `DEFAULT_CONFIG` 增加：

```js
tts: {
  textLang: 'auto',
  textLangWhenKana: '',
  ...
}
```

这样未配置的用户行为与现在完全一致，向后兼容。

### 5.2 语言决策函数

在 `src/tts.js` 内增加纯函数（无需新依赖）：

```js
// 平假名、片假名、半角片假名、长音、々
const KANA_RE = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F\u3005]/u;

function resolveTextLang(text, ttsConfig) {
  const textLang = String(ttsConfig.textLang ?? 'auto').toLowerCase();
  const whenKana = String(ttsConfig.textLangWhenKana ?? '').toLowerCase();
  if (whenKana && KANA_RE.test(String(text ?? ''))) {
    return whenKana;
  }
  return textLang;
}
```

将 `src/tts.js` 现有的：

```js
const textLang = String(tts.textLang ?? 'auto').toLowerCase();
```

替换为：

```js
const textLang = resolveTextLang(text, tts);
```

其余 payload 组装不变。

### 5.3 路由结果预期

| 弹幕 | 判定 | 最终 `text_lang` |
| --- | --- | --- |
| `真好听` | 无假名 | `all_zh` |
| `双厨狂喜666` | 无假名 | `all_zh` |
| `这个BGM真好听` | 无假名 | `all_zh` |
| `LIO八P` | 无假名 | `all_zh` |
| `NTE零` | 无假名 | `all_zh` |
| `こんにちは` | 有假名 | `auto` |
| `这是テストです` | 有假名 | `auto` |
| `主播はかわいい` | 有假名 | `auto` |
| `BGM` / `666` | 无假名 | `all_zh`（引擎仍会经 `full_en` 保留英文） |

### 5.4 可选的请求级覆盖

如果以后希望弹幕姬或调试工具显式指定语言，可在 `src/request.js` 解析 `input.lang` / `query.lang`，并沿 `enqueue()` 传入；当请求显式传 `lang` 时，`resolveTextLang` 优先采用请求值。该覆盖为可选，不影响 B 站弹幕姬现有接入。

### 5.5 单元验证

对 `resolveTextLang` 做表驱动测试，覆盖：

1. 无假名中文；
2. 中文 + ASCII 字母；
3. 中文 + 数字；
4. 平假名、片假名、半角片假名；
5. `々`；
6. 空文本；
7. `textLangWhenKana` 为空时的兼容行为。

同时跑 `npm run check` 确认语法。

---

## 6. L3 可选方案：引擎 `auto` 最小补丁

如果未来仍需要把 `textLang` 长期设为 `auto`（例如希望引擎自行处理中日韩更多组合），建议对引擎做最小补丁：**`auto` 分支中，无假名的 `ja` 片段回退为 `zh`**。

### 6.1 补丁位置

文件：`F:/AiSound/GPT-SoVITS-v2pro-20250604/GPT_SoVITS/TTS_infer_pack/TextPreprocessor.py`

当前代码：

```python
elif language == "auto":
    for tmp in LangSegmenter.getTexts(text):
        langlist.append(tmp["lang"])
        textlist.append(tmp["text"])
```

改为（概念代码，实际落盘前需按当前文件精确匹配）：

```python
elif language == "auto":
    for tmp in LangSegmenter.getTexts(text):
        lang = tmp["lang"]
        if lang == "ja" and not re.search(
            r"[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\u3005]", tmp["text"]
        ):
            # 无假名的“日文”片段在汉字层面与中文不可区分；
            # 中文直播间语境下默认回退中文，避免短中文被误读为日语音读。
            lang = "zh"
        langlist.append(lang)
        textlist.append(tmp["text"])
```

### 6.2 补丁后的预期

| 文本 | 补丁前 auto | 补丁后 auto |
| --- | --- | --- |
| `真好听` | `ja` | `zh` |
| `双厨狂喜` | `ja` | `zh` |
| `LIO八P` | `en/ja/en` | `en/zh/en` |
| `真好听666` | `ja` | `zh` |
| `こんにちは` | `ja` | `ja`（保留） |
| `这是テストです` | `zh/ja` | `zh/ja`（保留） |
| `主播はかわいい` | `zh/ja` | `zh/ja`（保留） |
| `日本語OK` | `ja/en` | `zh/en`（无假名歧义，按中文优先） |

### 6.3 补丁管理方式

沿用现有 `scripts/TTS_cpu_offload_v2pro.patch` 的套路：

1. 生成 `scripts/fix_tts_auto_cjk_lang.patch`；
2. 编写 `scripts/apply_tts_auto_cjk_lang.ps1`，支持 `-DryRun`、应用、`-Rollback`，记录源文件 SHA256；
3. GPT-SoVITS 升级后先校验目标文件版本，不匹配则拒绝应用；
4. 补丁很小，可随时回滚。

### 6.4 可选更深修复（L4 记录，不建议本期做）

`runtime/Lib/site-packages/split_lang` 存在两类上游问题，可作为后续向上游提 PR 的方向：

1. `_get_languages()` 重新检测后未把结果写回 `substr.lang`；
2. `_merge_side_substr_to_near()` 用“邻接语言是否出现在前 5 候选”来决定短片段归属，过于宽松。

这两项修复能改善 auto 总体质量，但引擎升级会覆盖 site-packages，维护成本高，收益低于 L1/L2。

---

## 7. 实施步骤与验收

### 7.1 推荐实施顺序

| 阶段 | 内容 | 负责人/触发条件 |
| --- | --- | --- |
| S0 | 备份 `config/config.json`、`config/replacements.json`；记录当前 commit | 开始前 |
| S1 | 实施 L1：`textLang` 改 `all_zh`；用 4.4 清单听音验证 | 立即 |
| S2 | 观察 1~3 场直播，统计是否出现日文弹幕被静音/吞字 | L1 生效后 |
| S3 | 若日文弹幕常见：实施 L2 假名路由，跑 `npm run check`，再用中日混合样本验证 | S2 结论 |
| S4 | 若仍保留引擎 `auto` 混合模式：实施 L3 补丁，先 `-DryRun` 再应用 | 可选 |
| S5 | 从 `data/danmaku.sqlite3` 导出近 7 天 `speechText`，离线跑语言路由统计，形成回归样本集 | 验收前 |
| S6 | 输出验收报告并归档到 `vibe-coding-reference` | 收尾 |

### 7.2 验收标准

1. 回归样本集中，纯中文/CJK+数字/CJK+字母弹幕的引擎前端语言标签无 `ja`（目标：CJK→`ja` 字符数 = 0）。
2. 至少 20 条问题弹幕人工听音，无日语音读/训读，数字无日文数字读法。
3. 含假名日文弹幕在 L2 开启后仍能正常朗读，不静音、不丢假名。
4. 首包延迟、显存峰值、队列吞吐与方案实施前相比无明显劣化（以现有 `gpt-sovits-performance-report.md` / `TTS性能优化计划.md` 的指标为基线）。
5. 中间件 `npm run check` 通过；配置热重载后 `textLang` 路由即时生效。
6. 可一键回滚到 `auto`。

---

## 8. 风险与边界

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 纯假名日语弹幕在只有 L1 时变成静音/丢字 | 日文观众体验下降 | 尽快实施 L2；L1 只作为观察窗口 |
| 无假名日文汉字词（`大丈夫`、`本当`、`日本語`）会被读成中文 | 个别日文弹幕错误 | 中日汉字歧义本质无法完全自动区分；可后续增加小词表/角色语言字段，不在本期强制解决 |
| 中文 + 假名混合句在 L2 走 `auto`，仍可能出现局部短中文误判 | 低概率 | L3 补丁可进一步兜底；L2 已覆盖绝大多数中文弹幕 |
| `all_zh` 对韩文、其他语言的兼容性 | 非中文/日文弹幕可能被中文前端过滤 | 当前直播间几乎不涉及；如需支持可在路由中增加韩文/英文规则 |
| 修改第三方引擎文件后升级被覆盖 | L3 失效 | 用 patch + SHA256 + `-Rollback` 管理；升级后重新校验 |
| 热重载瞬间并发请求读到新旧配置 | 单条弹幕可能仍按旧值合成 | 现有 `ConfigStore` 整体替换配置对象，影响面为单条请求，可接受 |
| `textSplitMethod` 保持 `cut5` 导致长句上下文缺失 | 在 `all_zh` 下无语言影响 | 保留 cut5；只有未来回到 auto 时才需重新评估 |

---

## 9. 涉及文件清单（实施时）

### 9.1 必改

- `config/config.json`：`tts.textLang = "all_zh"`，新增 `tts.textLangWhenKana = "auto"`（L1+L2）。
- `config/config.example.json`：同步示例。
- `src/config.js`：`DEFAULT_CONFIG.tts.textLangWhenKana` 默认空字符串。
- `src/tts.js`：新增 `KANA_RE` 与 `resolveTextLang()`，替换 `textLang` 计算处。

### 9.2 可选

- `src/request.js` / `src/index.js` / `src/tts.js`：请求级 `lang` 覆盖参数。
- `scripts/fix_tts_auto_cjk_lang.patch`：引擎 L3 补丁源文件。
- `scripts/apply_tts_auto_cjk_lang.ps1`：L3 补丁应用/回滚脚本。

### 9.3 不修改

- GPT-SoVITS 主流程（除 L3 可选补丁外）；
- `tts.promptLang`、角色模型路径、参考音频、`cut5`、播放器、数据库结构。

---

## 10. 结论

推荐路径是：**先把 `tts.textLang` 改为 `all_zh` 立即止血，再在中间件加“含假名→auto，否则→all_zh”的轻量路由**。这两步可以完全消除当前中文弹幕被误读为日语的问题，同时保留真日文弹幕；不需要改动 GPT-SoVITS，不增加推理成本，且每一步都可独立验证和回滚。引擎补丁仅作为未来继续使用原生 `auto` 时的可选加固项。
