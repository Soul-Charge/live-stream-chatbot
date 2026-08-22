# 项目协作规则

## 分析顺序

- 涉及项目诊断、解释或排障时，先读取项目根目录的 `README.md` 和 `package.json`。
- 再读取与当前问题直接相关的配置和源码；不要一开始就对整个项目做递归搜索。
- TTS 问题优先检查：
  - `config/config.json` 中的 `tts`、`gptSoVits`、`roles` 非敏感字段；
  - `config/replacements.json`；
  - `src/tts.js`；
  - `src/request.js`。
- 先报告已经确认的引擎、版本和关键参数，再进行进一步分析或联网搜索。
- 如果本地文件不足以确定答案，先向用户询问缺失信息，不要通过大范围搜索猜测。
- 用户只要求分析或解释时，不要修改文件；只有用户明确要求时才执行写入。

## 搜索范围和命令

- 优先使用 `rg` 或 `git grep`；`rg` 必须遵循项目的 `.gitignore`。
- 禁止直接执行未限定范围的 `grep -R ... .`、`find .` 或类似的大范围递归扫描，除非用户明确要求。
- 默认不要扫描以下目录：
  - `.venv*`
  - `.*cache`
  - `node_modules`
  - `GenieData`
  - `logs`
  - `data`
  - `dist`
  - `build`
- 搜索源码或项目文本时，优先限定到 `src`、`scripts`、`config`、`README.md` 和 `vibe-coding-reference`。
- 不要扫描当前项目的父目录、其他项目或整个磁盘；当前项目根目录是唯一默认工作范围。
- 执行可能遍历大量文件的命令前，先说明搜索范围和原因；除非用户明确要求，不要读取模型、虚拟环境、依赖包或缓存中的二进制文件。

## 本项目的 TTS 诊断重点

- 本项目使用 GPT-SoVITS v2ProPlus HTTP 推理 API。
- 诊断语言、断句或合成问题时，重点核对最终发送的 `text_lang`、`prompt_lang`、`text_split_method`、文本替换结果和角色模型参数。
- 本地证据确认后，再使用联网资料分析 GPT-SoVITS 的具体行为；不要在尚未确认引擎和参数时直接泛化推测。
