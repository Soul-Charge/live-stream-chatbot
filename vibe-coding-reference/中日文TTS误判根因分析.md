# 弹幕中文被读成日语 / 中英数字混合被按日语合成：根因分析报告

> 范围：`live-stream-chatbot` 中间件 + `F:/AiSound/GPT-SoVITS-v2pro-20250604`（v2ProPlus，实际由 `API.bat` 启动 `api_v2.py`）。
> 结论状态：只定位原因，不包含修复改动。
> 分析方式：通读两端源码 + 使用引擎自带 `runtime/python.exe` 直接调用其真实的 `LangSegmenter` / `clean_text` 复现。

---

## 1. 结论摘要

弹幕“中文读成日文”以及“中文 + 字母/数字混合时容易混进日语合成”，根源不在播放器、不在角色切换、也不在 `promptLang`，而在下面这条链路上：

1. **中间件把 `text_lang: "auto"` 原样透传给 GPT-SoVITS**（`config/config.json` 的 `tts.textLang = "auto"`，`src/tts.js` 组装 payload）。
2. **GPT-SoVITS 的 `auto` 实际含义是“对文本做无先验的多语种切片识别”**，而不是“以中文为主、遇到假名才切日文”。`TextPreprocessor.get_phones_and_bert()` 在 `auto` 分支直接调用 `LangSegmenter.getTexts(text)`，不传任何默认语言。
3. **`LangSegmenter` / `split_lang` 对短中文片段的识别可靠性不足**，大量 2~5 字弹幕片段被 `fast_langdetect` 判成 `ja`，或只是“日文出现在候选列表里”就被并到日文片段。
4. **被标成 `ja` 的片段会进入日文前端 `text/japanese.py` → pyopenjtalk**。汉字按日语音读/训读生成音素，数字按日文数字读法生成音素，这就是听到“中文被念成日文”的直接机制。
5. **中英数字混合文本的问题不是字母本身被读成日文，而是混合文本把中文切成了更短的孤立片段**，这些短中文片段更容易误判为 `ja`；随后相邻数字按“就近语言”规则并入 `ja` 片段，于是整段“中文 + 数字”一起走日文 G2P。字母片段有 `full_en` 兜底通常仍为 `en`，但夹在中间的单个汉字（如替换表里的 `NTE零`、`LIO八P` 中的“零”“八”）几乎必然被单独拿出来识别，单字误判率很高。
6. `tts.textSplitMethod = "cut5"` 会先按标点把弹幕切成小句再逐句识别，进一步缩短了识别上下文，是明显的放大器。

### 实测一句话总结

- `textLang = "auto"` 时，`真好听` → `ja`，日文 G2P 输出 `ma [konomin] kiN`（日语音读）；中文 G2P 应为 `zh en1 h ao3 t ing1`。
- `textLang = "auto"` 时，`真好听666` → 整段 `ja`，`666` 走日文数字读法 `ro[clpyaku]...`，而不是 `liu4 liu4 liu4`。
- 同一批语料按引擎 `textLang = "zh"` 分支的实际处理逻辑验证（`LangSegmenter.getTexts(text)` 输出中所有非 `en` 片段都重标为 `zh`，见 `TextPreprocessor.py:159-168`），上述中文片段 0 个被标成 `ja`。

---

## 2. 当前完整请求链路

```
B站弹幕姬
  -> 中间件 src/index.js / src/request.js（清洗、替换、长度限制）
  -> src/tts.js #synthesize()
       构造 payload: text_lang = config.tts.textLang   // 当前为 "auto"
                     prompt_lang = config.tts.promptLang // 当前为 "ja"
                     text_split_method = "cut5"
                     streaming_mode = true
  -> POST http://127.0.0.1:9880/tts
  -> 引擎 api_v2.py
       check_params() 允许 auto（v2_languages 含 "auto"）
       tts_handle() -> tts_pipeline.run(req)
  -> GPT_SoVITS/TTS_infer_pack/TTS.py run()
       text_lang = inputs["text_lang"]              // "auto"
       preprocess() 或 pre_seg_text() 先按 cut5 分句
       -> TextPreprocessor.get_phones_and_bert(..., language="auto")
            language == "auto":
              for tmp in LangSegmenter.getTexts(text):  // 无默认语言
                  langlist.append(tmp["lang"])
                  textlist.append(tmp["text"])
            -> 对每段调用 clean_text_inf(text_segment, lang)
                 lang="zh" -> text/chinese2.py + G2PW/pypinyin
                 lang="ja" -> text/japanese.py + pyopenjtalk
                 lang="en" -> text/english.py + g2p_en
       -> phones/bert 送入 t2s -> SoVITS v2ProPlus -> 音频
```

关键文件位置：

| 环节 | 文件与位置 | 当前行为 |
| --- | --- | --- |
| 中间件语言参数 | `config/config.json` `tts.textLang = "auto"`；`src/tts.js:216` 读取并 lower；`src/tts.js:250-263` 放进 payload | 不做任何语言判断，完全交给引擎 |
| 分句配置 | `config/config.json` `tts.textSplitMethod = "cut5"` | 按标点切成小句再识别 |
| API 校验 | `GPT-SoVITS-v2pro-20250604/api_v2.py` `check_params()` | `auto` 是合法值，直接放行 |
| 引擎入口 | `GPT_SoVITS/TTS_infer_pack/TTS.py:1028/1116/1163/1180` | 每个 cut5 分句单独走语言前端 |
| auto 行为 | `GPT_SoVITS/TTS_infer_pack/TextPreprocessor.py:148-150` | `auto` = `LangSegmenter.getTexts(text)`，无默认中文先验 |
| zh 行为对照 | 同文件 `TextPreprocessor.py:159-168` | 非英文片段强制设为 `language`（zh），因此不会误成 ja |
| 语言分段器 | `GPT_SoVITS/text/LangSegmenter/langsegmenter.py` | 二次修正 `split_lang` 输出，但只对英文/未知语言兜底 |
| 底层分段与检测 | `runtime/Lib/site-packages/split_lang/split/splitter.py`、`detect_lang/detector.py` | budoux 切块 + `fast_langdetect` 逐块识别 |
| 日文发音前端 | `GPT_SoVITS/text/japanese.py:151/267` | `pyopenjtalk.g2p()`，汉字/数字按日语读出 |
| 中文发音前端 | `GPT_SoVITS/text/chinese2.py:73/180` | G2PW/pypinyin，数字按中文读出 |

---

## 3. 实测复现证据

以下实验直接导入引擎运行时里的真实模块（未跑模型推理，只跑文本前端）：

- Python：`F:/AiSound/GPT-SoVITS-v2pro-20250604/runtime/python.exe`
- 模块：`GPT_SoVITS.text.LangSegmenter.LangSegmenter`、`text.cleaner.clean_text`

### 3.1 分段结果与音素对照

| 输入弹幕 | `textLang=auto` 的分段结果 | 误判段进入日文前端后的音素（节选） | 中文前端对照（节选） |
| --- | --- | --- | --- |
| `真好听` | `[ja] 真好听` | `ma [ konomin ] kiN`（日语音读） | `zh en1 h ao3 t ing1` |
| `双厨狂喜` | `[ja] 双厨狂喜` | `so [ okuriyaky] ooki`（日语音读） | `sh uang1 ch u2 k uang2 x i3` |
| `这个BGM真好听` | `[zh] 这个` / `[en] BGM` / `[ja] 真好听` | “真好听”按日语读出 | “真好听”按中文读出 |
| `up主声音好好听` | `[en] up` / `[ja] 主声音好好听` | 后半句整段按日语读出 | 后半句按中文读出 |
| `LIO八P` | `[en] LIO` / `[ja] 八` / `[en] P` | “八”为 `ha [chi`（hachi） | “八”为 `b a1` |
| `NTE零`（`NTE0` 的替换结果） | `[en] NTE` / `[ja] 零` | “零”为 `r e ] e`（rei/zero） | “零”为 `l ing2` |
| `真好听666` | `[ja] 真好听666` | 数字走日文数字读法 `ro[clpyaku]...` | `l iu4 l iu4 l iu4` |
| `666真好听` | `[ja] 666真好听` | 数字走日文数字读法 | 数字走中文数字读法 |
| `中文abc混合123，真好听` | `[zh] 中文` / `[en] abc` / `[zh] 混合` / `[ja] 123，真好听` | 数字 + “真好听”整段按日语读出 | 数字 + “真好听”按中文读出 |
| `双厨狂喜123abc` | `[ja] 双厨狂喜123` / `[en] abc` | 中文和数字整体日语化 | — |
| 纯 `666` | `[zh] 666` | — | — |

观察：

- 纯数字没有邻接误判片段时通常能落到 `zh`；问题发生在“数字邻接的中文片段先被误判为 `ja`”之后，数字被并进 `ja` 片段。
- 字母片段由于 `full_en` 兜底基本是 `en`，但字母会把中文切成更短的片段，间接提高误判率。
- `NTE0` 原串会被 `full_en` 判成 `en`；替换成 `NTE零` 后，“零”作为单个 CJK 片段被单独识别为 `ja`，替换规则反而在 auto 模式下失效或恶化。

### 3.2 小语料统计

用 152 条常见中文弹幕短语（主播互动、梗、数字、中英混写等）直接调用 `LangSegmenter.getTexts(text)`（等价于 `textLang=auto`）：

- 有 29 / 152 条出现“至少一个汉字片段被标为 `ja`”；
- 按汉字字符统计，481 个 CJK 字符中有 93 个被标为 `ja`，比例约 **19.3%**；
- 同一批文本按引擎 `textLang=zh` 分支的真实逻辑处理（`LangSegmenter.getTexts(text)` 后把所有非 `en` 片段重标为 `zh`），CJK→`ja` 为 **0**。

> 这是代表性语料的离线统计，不是线上弹幕数据库的精确占比；但足以说明 `auto` 在当前场景不是偶发错误，而是稳定、可复现的系统性误判。

### 3.3 直接检测器的低置信度与错误高分

对同一引擎内置 `fast_langdetect` 的直接检测：

| 片段 | 最佳语言与分数 | 说明 |
| --- | --- | --- |
| `主声音` | `ja` **0.9996** | 纯中文短片段被极高置信度判成日文 |
| `真好听` | `ja` 0.716 | 超过阈值即直接采用 |
| `双厨` | `zh` 0.842 | 最佳是中文，但候选列表同时含 `ja`，后续侧边合并仍把整段变成 `ja`（见 4.2） |
| `狂喜` | `ja` 0.544 | 只有 0.544 也被采用，没有任何最低置信度门槛 |

---

## 4. 根因分解

### 4.1 中间件层：`auto` 是对当前场景最不合适的语言策略

`config/config.json`：

```json
"tts": {
  "textLang": "auto",
  "promptLang": "ja",
  "textSplitMethod": "cut5"
}
```

`src/tts.js` 只是把配置值放进请求：

```js
const textLang = String(tts.textLang ?? 'auto').toLowerCase();   // src/tts.js:216
const payload = {
  text,
  text_lang: textLang,             // 当前恒为 "auto"
  prompt_lang: tts.promptLang,     // 当前为 "ja"
  text_split_method: tts.textSplitMethod,  // 当前为 "cut5"
  ...
};
```

中间件自身没有、也不打算做语言判断。对“绝大多数是中文弹幕、偶尔夹杂字母/数字/少量日文”的直播间来说，`auto` 让每条中文弹幕都必须先经过一个对短中文并不可靠的检测器；而引擎的 `zh` / `all_zh` 分支本来可以把“无假名的 CJK 文本”固定按中文处理，`auto` 没有使用这种中文先验。

因此**中间件的 `textLang=auto` 是触发条件**，不是发音错误的最终执行者，但它是所有误判能发生的前提。

### 4.2 引擎层：`auto` 的语种检测算法对短中文片段不可靠

`TextPreprocessor.get_phones_and_bert()` 的 `auto` 分支（`TextPreprocessor.py:148-150`）：

```python
elif language == "auto":
    for tmp in LangSegmenter.getTexts(text):   # 注意：没有传 default_lang
        langlist.append(tmp["lang"])
        textlist.append(tmp["text"])
```

`LangSegmenter.getTexts(text)` 内部链路：

1. `LangSplitter.pre_split()` 把文本切成 `ZH_JA`、`OTHERS`（拉丁字母等）、`DIGIT`、`PUNCTUATION`、`NEWLINE` 区段。
2. CJK 区段用 `_parse_zh_ja()` 解析：**先用日文 budoux 解析器，再用中文 budoux 解析器**（`splitter.py:306-340`），于是纯中文也会先被按日文分块习惯切碎。
3. 每个小块用 `fast_langdetect` 检测（`detect_lang/detector.py`）。2~4 字中文的检测质量明显下降，且结果没有最低置信度门槛，0.5~0.7 的 `ja` 结果会被直接采用。
4. 更关键的是 `_merge_side_substr_to_near()`（`splitter.py:463-509`）的规则：

```python
is_possible_same_lang_with_near = (
    substrings[1].lang in possible_detection_list(substrings[0].text)
    and substrings[1].length <= 5
)
```

这里的 `possible_detection_list()` 返回的是 `fast_langdetect.detect_multilingual(k=5, threshold=0.01)` 的**前 5 个候选语言**，而不是最佳语言。只要邻接片段的语言出现在这个宽松候选列表里，短片段就会被并入邻接片段。

以 `双厨狂喜` 为例：

- budoux 切成 `双厨` + `狂喜`；
- `双厨` 最佳检测是 `zh`（0.842），但候选列表为 `['zh', 'ja']`；
- `狂喜` 被检测为 `ja`（0.544）；
- 侧边合并发现 `ja` 出现在 `双厨` 的候选列表里，于是把 `双厨` 也改成 `ja`；
- 最终整条 `双厨狂喜` 变成 `ja`。

5. 另一个缺陷是 `_get_languages()`（`splitter.py:1148-1170`）虽然重新检测了每段语言，却**只把结果存进局部变量 `cur_lang`，没有写回 `substr.lang`**。也就是算法里一次本可纠错的重检测实际上没有生效。
6. `_special_merge_for_zh_ja()` 里还有“日文字符数 ≥ 中文字符数 × 10 时，把所有 `zh` 改成 `ja`”的整体覆盖规则（`splitter.py:594-690`），会把少量误判放大成整段翻转。
7. `LangSegmenter` 的后处理只对 `full_en`（纯 ASCII 段）和 `x`（未知语言）兜底；**已经被标成 `ja` 的纯中文片段没有任何中文兜底**，`full_cjk` 只处理 `x`，救不回 `ja`。

### 4.3 中文 + 字母/数字混合：为什么更容易“混日语”

混合文本更容易出问题，主因不是字母或数字被检测成日文，而是：

#### a) 混合文本把中文切成更短的孤立片段

`pre_split()` 会把汉字和拉丁字母、数字拆到不同区段。例如：

- `这个BGM真好听` → `这个`(CJK) + `BGM`(ASCII) + `真好听`(CJK)。`BGM` 被 `full_en` 救回 `en`，但剩下的 `真好听` 只有 3 个字，单独识别成 `ja`。
- `up主声音好好听` → `up`(en) + `主声音好好听`(ja)。5 字中文片段被检测器以 0.9996 判成日文。
- `LIO八P` → `LIO`(en) + `八`(ja) + `P`(en)。单字 `八` 被孤立后判成 `ja`，读作 `hachi`。

因此“中英数字混合容易混日语”的准确机制是：**字母/数字充当了切分符，把原本有上下文的中文切成 1~5 字片段；这些片段正是检测器误判率最高的输入长度。**

#### b) 数字没有英文那样的兜底，会被误判的邻居“带走”

`LangSegmenter.getTexts()` 第一行就关闭了跨数字合并：

```python
lang_splitter.merge_across_digit = False   # langsegmenter.py:92
```

数字片段随后进入自定义的 `have_num` 后处理（`langsegmenter.py:169-198`）。规则是按“前一片段、后一片段的语言是否相同/谁更长/标点位置”决定数字归属；**当前后邻接片段是 `ja`（哪怕这个 `ja` 本身就是误判）时，数字会被并入 `ja`**。

于是出现：

- `真好听666`：`真好听` 误判 `ja` → 数字并入 → 整段 `ja`，数字按日文读出；
- `中文abc混合123，真好听`：`123` 后面是标点 + 误判为 `ja` 的 `真好听`，最终 `123，真好听` 整段 `ja`。

#### c) 现有替换表是症状证据，但在 auto 下会二次误判

`config/replacements.json` 中已有：

```json
"NTE0": "NTE零",
"LIOPPPPPPPP": "LIO八P",
"1849305599": "给木零",
"3538962": "NTE零"
```

这些规则显然是为了“强制把数字/字母串读成中文”而加的。但替换发生在语言检测之前，替换后新增的单个汉字反而更容易被 auto 单独判成 `ja`：

- `NTE零` → `[en] NTE` / `[ja] 零`，`零` 读 `rei`；
- `LIO八P` → `[en] LIO` / `[ja] 八` / `[en] P`，`八` 读 `hachi`。

所以这些替换不是根因，但可以证明“中英数字混合发音错误”在配置层已经被长期用补丁式替换对抗，而真正的语种误判发生在替换之后、G2P 之前。

### 4.4 `cut5` 分句是放大器

`tts.textSplitMethod = "cut5"` 会在语言检测之前按 `，。！？、…` 等标点切成小句；随后 `TTS.py` 对每个小句分别调用 `segment_and_extract_feature_for_text(..., "auto")`。这意味着每条弹幕的语言识别上下文只有一个小句，而不是整条弹幕。

即使不分句，`auto` 本身仍会误判（3.1 中的 `真好听`、`双厨狂喜` 单句就是证明），但 `cut5` 保证了下述情况一定发生：

- 长弹幕中本来可能靠整体上下文稳定的部分，被拆成 2~5 字短句；
- 每个短句独立承担一次检测，任一短句误判就只影响该句，造成“一句话前半中文、后半日文”的割裂听感。

> 附注：`api_v2.py` 中 `streaming_mode == 1` 分支会同时匹配 Python 布尔值 `True`（`True == 1`），因此中间件发送的 `streaming_mode: true` 实际走的是 `return_fragment=True`（旧式分段返回）。这个布尔值处理是另一个值得注意的问题，但它影响的是返回方式，不是语种判定——无论分段返回还是整段返回，`cut5` 都已在检测前完成切句，故未把其列为发音错误根因。

### 4.5 明确排除的因素

| 疑似因素 | 是否根因 | 依据 |
| --- | --- | --- |
| `tts.promptLang = "ja"` | 否 | `prompt_lang` 只用于参考音频文本 `prompt_text` 的 G2P 和 prompt 缓存（`TTS.py:1138-1163`）；目标文本的语种由 `text_lang` 独立决定，代码中不存在 prompt 语言向目标文本语言传递的路径。 |
| 参考音频是日语角色 | 否 | 参考音频决定音色/声纹与 prompt semantic，不参与目标文本的 `zh/ja/en` 前端路由；日语音色可能带来口音，但不会把中文汉字变成日语音读。 |
| 角色模型切换、`set_weights` | 否 | 权重切换只换 t2s/SoVITS 模型，语言前端与配置版本无关。 |
| 中间件清洗/替换 | 部分相关 | 替换本身不直接导致误判，但替换后产生的孤立单字会经过 auto 识别并可能被判 `ja`（见 4.3c）。 |
| 内存缓存 / watchdog | 否 | 不参与文本前端。 |
| `streaming_mode: true` 的布尔分支 | 否（发音层面） | 只改变音频返回方式，不改变 `pre_seg_text` + `text_lang=auto` 的识别路径。 |

---

## 5. 症状 → 原因映射

| 用户观察到的症状 | 对应根因 |
| --- | --- |
| 一条纯中文弹幕整体像日语 | `textLang=auto` + 短中文片段被 `fast_langdetect` 判 `ja` + 日文 pyopenjtalk G2P（4.1、4.2） |
| 一句话前半中文、后半日语 | `cut5` 逐小句独立识别，后半短句误判 `ja`（4.4） |
| 中文 + 数字整段变成日语数字读法 | 数字无 `full_en` 兜底，按邻居语言归并；邻居中文先误判 `ja`，数字并入 `ja`（4.3b） |
| 中文 + 字母混合时中文部分变日语 | 字母被 `full_en` 判 `en` 本身没问题，但它把相邻中文切成 1~5 字短片段，短片段被误判 `ja`（4.3a） |
| `NTE0` / `LIO八P` 等替换词听起来仍是日文 | 替换后新增的单字 `零`/`八` 被 auto 独立识别为 `ja`（4.3c） |
| 某些 2~4 字中文梗（双厨狂喜、真香、全体起立）稳定读错 | budoux 切块 + 候选语言侧边合并 + 无置信度阈值 + 无中文兜底（4.2） |

---

## 6. 后续验证建议（仅验证，不含修复）

1. 收集线上 `data/danmaku.sqlite3` 中 `cleanText/speechText` 样本，离线调用引擎真实 `LangSegmenter.getTexts(text)`，计算真实误判率；本报告第 3.2 节只是代表性短语的离线估计。
2. 在 API 控制台（不要被 `stdio: 'ignore'` 吞掉日志）观察 `TTS.py` 打印的“前端处理后的文本(每句)”和 `LangSegmenter` 输出，确认线上日志中的 `ja` 命中片段。
3. 用同一批样本分别以 `textLang = "auto"` 和 `textLang = "zh"` 合成对比，验证差异是否只在文本前端；若 `zh` 模式下中文稳定正确，则可确认根因链。
4. 对真日文弹幕样本（含假名）做同样对比，确认不能简单全局改 `zh` 的原因：`zh` 模式会把假名段也压成中文路径（`LangSegmenter.getTexts(text, "zh")` 对非英文段全部返回 `zh`），后续方案需要权衡中日混合场景。

---

## 7. 附录：关键源码位置

### 中间件

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `config/config.json` | `tts.textLang` / `promptLang` / `textSplitMethod` | `auto` / `ja` / `cut5` |
| `config/replacements.json` | `replacements` | `NTE0→NTE零`、`LIOPPPPPPPP→LIO八P` 等 |
| `src/tts.js` | 216、250-263 | 读取 `textLang` 并组装 payload |
| `src/request.js` | `cleanText()` | 清洗与替换，无语言逻辑 |

### GPT-SoVITS v2ProPlus 引擎

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `api_v2.py` | 307-330 | 校验并接受 `text_lang=auto` |
| `GPT_SoVITS/TTS_infer_pack/TTS.py` | 1028、1116、1163、1172、1180、1191 | 目标文本按 `text_lang` 走前端 |
| `GPT_SoVITS/TTS_infer_pack/TextPreprocessor.py` | 122-207 | `auto` 分支调用 `LangSegmenter.getTexts(text)`，逐段 `clean_text_inf` |
| `GPT_SoVITS/TTS_infer_pack/TextPreprocessor.py` | 59-114 | `preprocess` / `pre_seg_text` 先按 `cut5` 分句 |
| `GPT_SoVITS/text/LangSegmenter/langsegmenter.py` | 90-211 | 自定义语言后处理、数字归属、`full_en`/`full_cjk` 兜底 |
| `runtime/Lib/site-packages/split_lang/split/splitter.py` | 108-180 | CJK/数字/字母/标点预切分 |
| 同上 | 306-340 | 日文 budoux 先切、中文 budoux 后切 |
| 同上 | 349-520 | 智能合并、侧边合并、未知语言填充 |
| 同上 | 594-690 | `ja` 长度 ≥ `zh`×10 时整段转 `ja` |
| 同上 | 1148-1170 | `_get_languages()` 检测结果未写回 `substr.lang` |
| `runtime/Lib/site-packages/split_lang/detect_lang/detector.py` | `fast_lang_detect` / `possible_detection_list` | 逐块检测、返回前 5 候选 |
| `GPT_SoVITS/text/japanese.py` | 151、267-271 | 日语 G2P：`pyopenjtalk.g2p` |
| `GPT_SoVITS/text/chinese2.py` | 73、180-190 | 中文 G2P：G2PW/pypinyin，数字中文读法 |

### 复现示例（引擎目录下运行）

```bash
cd /mnt/f/AiSound/GPT-SoVITS-v2pro-20250604
PYTHONUTF8=1 ./runtime/python.exe -u - <<'PY'
import sys
sys.path.insert(0, '.')
sys.path.insert(0, 'GPT_SoVITS')
from GPT_SoVITS.text.LangSegmenter import LangSegmenter
for t in ['真好听', '双厨狂喜', '这个BGM真好听', 'LIO八P', '真好听666']:
    print(t, [(x['lang'], x['text']) for x in LangSegmenter.getTexts(t)])
PY
```
