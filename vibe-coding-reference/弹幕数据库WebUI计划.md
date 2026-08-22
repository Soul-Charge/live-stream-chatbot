# 弹幕数据库 WebUI 计划（Danmaku DB WebUI Plan）

> 目标：在现有 `live-stream-chatbot` 上增加一个本地 WebUI，方便查看弹幕数据库内部数据，并管理高频弹幕音频（扫描、生成、重新生成、试听）。
> 本计划只做规划与设计；代码实施按阶段拆分，先静态页面、后增强查询、再打磨体验。

## 1. 背景与目标

> 当前工作区检查结果：`data/` 目录为空，`data/danmaku.sqlite3` 尚未在仓库中出现（已被 `.gitignore` 忽略）。WebUI 必须兼容“数据库尚未创建 / 未启用 / 无数据”的情况，并提示用户先启动服务产生数据。

当前项目已经实现弹幕数据库（SQLite）与一组 HTTP API（现有查询接口 + 规划中的高频弹幕接口）：

- `GET /health`：服务与数据库健康信息
- `GET /db/health`：数据库统计
- `GET /db/danmaku`：弹幕检索（分页/过滤）
- `GET /db/hot`：高频弹幕排行
- `GET /db/users`：观众列表
- `GET /db/users/:id`：单个观众时间线
- `GET /db/sessions`：直播场次列表
- `GET /db/cache`：磁盘缓存条目列表（阶段 3 规划新增）
- `GET /db/cache/stats`：缓存汇总统计（阶段 3 规划新增）
- `GET /db/hot-jobs`：热句预生成任务列表（阶段 3 规划新增）
- `GET /db/hot-danmaku`：高频弹幕列表（阶段 3 规划新增）
- `POST /db/hot-danmaku/scan`：手动扫描高频弹幕（阶段 3 规划新增）
- `POST /db/hot-danmaku/:id/generate`：生成/重新生成高频弹幕音频（阶段 3 规划新增）
- `GET /db/hot-danmaku/:id/audio`：获取音频流用于试听（阶段 3 规划新增）

但目前这些接口只能通过命令行 / 手工 HTTP 请求查看，不直观。本计划要新增一个本地 Web 页面，把上述接口包装成可视化的表格、筛选器和统计卡片，方便日常查看内部数据。

### 1.1 目标

1. **查看为主**：弹幕明细、用户、场次、高频弹幕等数据以查看为主。
2. **高频弹幕管理**：针对高频弹幕提供“扫描、生成、重新生成、试听”操作；生成/重新生成需要 Token 鉴权。
3. **开箱即用**：不引入前端构建链、不依赖外部 CDN；用原生 HTML/CSS/JS 实现，直接由现有 Node HTTP 服务托管。
4. **覆盖核心数据**：弹幕明细、用户列表/时间线、直播场次、高频弹幕、音频试听、数据库健康状态。
5. **本机安全**：默认仅监听 `127.0.0.1`；写操作要求 `X-DB-Token`。

### 1.2 非目标

- 不做普通弹幕的编辑、删除、导入导出（导出可作为后续增强）。
- 不做复杂鉴权/多用户系统；保持单机自用。
- 不做移动端深度适配，但基础响应式布局会保留。
- 不替代实时 TTS 主链路，不阻塞弹幕写入。
- 高频弹幕的“生成/重新生成”是受控写操作，不是任意数据修改。

## 2. 现状分析

### 2.1 已有数据表

数据库 schema 见 `vibe-coding-reference/弹幕数据库构建计划.md`，核心表：

| 表 | 内容 | WebUI 用途 |
| --- | --- | --- |
| `live_sessions` | 直播场次 | 场次列表、按场次筛选 |
| `users` | 发言用户 | 观众排行、用户时间线 |
| `danmaku` | 弹幕主表 | 弹幕明细浏览/检索 |
| `tts_audio_cache` | TTS 文件缓存 | 可选：缓存命中情况 |
| `hot_phrase_jobs` | 热句预生成任务 | 可选：任务状态查看 |
| `hot_danmaku` | 高频弹幕表（规划新增） | 高频弹幕列表、音频地址、生成状态 |

### 2.2 已有 API 的可用字段

`GET /db/danmaku` 已支持：

- `from` / `to`：毫秒时间戳或可解析日期
- `uid` / `username` / `text` / `role` / `status`
- `limit`（1~200）/ `offset`（0~1000000）

返回字段包含：`id, session_id, received_at_ms, user_id, uid, username, raw_text, clean_text, speech_text, text_len, role_key, role_comment, accepted, reject_reason, tts_status, used_cache, tts_error, cache_key, metadata`。

### 2.3 缺口

- 目前没有静态文件路由，浏览器无法直接打开 HTML 页面。
- API 没有按 `session_id` 过滤弹幕；WebUI 的“按场次查看”需要补充该参数。
- 还没有 `/db/hot-danmaku` 系列接口；WebUI 的高频弹幕页面依赖阶段 3 新增 API。
- 还没有 `/db/cache`、`/db/hot-jobs` 接口；缓存/任务页面作为可选扩展。
- 没有面向人的时间格式化、状态标签、分页控件、音频播放与波形图等前端能力。

## 3. 技术选型

| 项目 | 选择 | 理由 |
| --- | --- | --- |
| 前端框架 | 无（原生 HTML + CSS + Vanilla JS） | 项目无前端依赖；页面简单；避免引入 node_modules / 构建链 |
| 样式 | 手写 CSS（深色或浅色均可） | 轻量、可控；不依赖网络 CDN |
| 图表 | 初期不引入；统计用数字卡片和表格 | 降低复杂度；后续需要再评估 ECharts 本地文件 |
| 静态服务 | 现有 Node `http.createServer` 增加静态文件分支 | 不新增端口、不新增进程、不新增依赖 |
| 数据访问 | 直接调用现有 `/db/*` API | 保持单一数据入口，WebUI 不直接打开 SQLite 文件 |
| 鉴权 | 复用 `database.readToken` | 已有 API 层校验，WebUI 仅负责携带请求头 |

## 4. 页面与功能设计

### 4.1 总体布局

单页应用（SPA）风格，顶部为导航标签，主体为对应面板。

```
+----------------------------------------------------------+
|  弹幕数据库 WebUI            [Token 输入] [刷新]          |
+----------------------------------------------------------+
|  总览 | 弹幕 | 用户 | 场次 | 热句 | 高频弹幕 |
+----------------------------------------------------------+
|  当前面板内容（统计卡片 / 筛选表单 / 表格 / 分页）         |
+----------------------------------------------------------+
```

### 4.2 页面清单

#### 1) 总览（Overview）

- 调用 `GET /db/health`；阶段 3 后可再调用 `GET /db/hot-danmaku` 做汇总
- 展示：
  - 数据库是否启用、失败原因（若禁用）
  - 数据库文件路径、文件大小
  - 总弹幕数、已接受数、被拒数、TTS 错误数
  - 最后一条弹幕时间
  - `tts_status` 分布（accepted / queued / synthesizing / played / cache_hit / disk_cache_hit / skipped / error 等）
  - 高频弹幕统计：高频弹幕总数、待生成数、已生成数、失败数（阶段 3）

#### 2) 弹幕浏览（Danmaku）

- 调用 `GET /db/danmaku`
- 筛选条件：
  - 文本关键字（`text`）
  - 用户名（`username`）
  - 角色（`role`，下拉从配置/已知角色或自由输入）
  - TTS 状态（`status`，下拉）
  - 时间范围（`from` / `to`，本地时间输入，转换为 epoch ms）
  - 是否只看被拒绝（`accepted=0`）— 需要后端支持或前端过滤；优先后端支持
- 表格列：
  - 时间（本地化格式）
  - 用户（uid/username）
  - 角色（role_key/role_comment）
  - 原始文本 / 清洗文本 / 合成文本（可展开/悬浮）
  - TTS 状态
  - 是否接受 / 拒绝原因 / 错误信息
  - 元数据（JSON，可点击查看）
- 分页：上一页 / 下一页 / 当前页 / 总数；每页 20/50/100 可选

#### 3) 用户（Users）

- 调用 `GET /db/users`
- 表格：用户名、UID、发言数、首次/最后发言时间
- 点击用户进入该用户的时间线：
  - 调用 `GET /db/users/:id?limit=...&offset=...`
  - 展示该用户的历史弹幕（可复用弹幕表格组件）

#### 4) 场次（Sessions）

- 调用 `GET /db/sessions`
- 表格：场次 ID、开始时间、结束时间、标题、房间号
- 点击某场次后，在弹幕页自动带上 `session_id` 过滤（需 API 支持，见 5.2）

#### 5) 热句统计（Hot Phrases）

- 调用 `GET /db/hot?minutes=...&minCount=...`
- 参数：统计窗口（默认 10 分钟）、最低次数（默认 3）
- 表格：角色、文本、次数、首次/最后出现时间
- 可显示“复制文本”按钮，便于后续调试

#### 6) 高频弹幕（High-Frequency Danmaku）

这是高频弹幕缓存的核心页面。

- 调用：
  - `GET /db/hot-danmaku`：获取高频弹幕列表
  - `POST /db/hot-danmaku/scan`：手动触发扫描
  - `POST /db/hot-danmaku/:id/generate`：生成/重新生成音频
  - `GET /db/hot-danmaku/:id/audio`：获取音频流
- 顶部：
  - 手动“扫描高频弹幕”按钮
  - 当前规则展示：如 `24h ≥ 10次`、`1h ≥ 5次`
  - 筛选：角色、状态、文本、规则
- 列表以“高频弹幕卡片”展示，每个卡片大致如下：

```
------------------------------------------------------------
| 这里是弹幕内容                                            |
| 地址：data/hot-danmaku/樱羽艾玛/3f9a2c....wav             |
| [波形图 Canvas]                                           |
| 音频时长：00:03.21    [播放]    [重新生成]                |
------------------------------------------------------------
```

- 每个卡片包含：
  - 弹幕内容
  - 角色显示名（`role_comment`）
  - 音频地址（相对路径；未生成为“未生成”）
  - 波形图
  - 音频时长
  - 播放按钮
  - 重新生成按钮
- 状态标签：
  - `pending`：灰色
  - `generating`：蓝色/动画
  - `ready`：绿色
  - `error`：红色
- 未生成时按钮显示“生成”，已生成后显示“重新生成”。
- 波形图用 Canvas 绘制，通过 Web Audio API 解码音频；解码失败时仍保留播放器。

#### 7) 缓存/任务（可选）

- `GET /db/cache`、`GET /db/cache/stats`：查看磁盘缓存条目与统计（如果保留通用缓存表）。
- `GET /db/hot-jobs`：查看历史生成任务（如果保留任务表）。
- 该页可作为后续扩展，不作为高频弹幕核心流程。

### 4.3 公共交互

- **Token 处理**：如果接口返回 401，弹出/显示 Token 输入框；保存到 `localStorage`，之后所有请求自动带 `X-DB-Token`。
- **空状态**：数据库未启用、无数据、无匹配结果时显示友好空状态。
- **错误提示**：接口失败时在页面顶部显示错误信息，不白屏。
- **刷新**：手动刷新当前面板；总览可自动每 10~30 秒刷新（可选）。

## 5. 后端改动设计

### 5.1 静态文件服务

在 `src/index.js` 中增加一个 `serveStaticWebUi` 分支：

- 当 `GET` 且路径为 `/`、`/webui`、`/webui/index.html` 时，返回 `webui/index.html`。
- 当 `GET` 且路径为 `/webui/*` 时，从 `webui/` 目录读取对应文件（`app.js`、`style.css` 等）。
- 使用白名单扩展名与 MIME 映射：`.html`、`.js`、`.css`、`.svg`、`.png`、`.ico`。
- 防止路径穿越：只允许 `webui/` 下的相对路径，`path.normalize` 后校验前缀。
- 静态资源可加 `Cache-Control: no-cache`，方便开发调试。

建议目录：

```
webui/
  index.html
  app.js
  style.css
```

### 5.2 按场次过滤弹幕（小增强）

在 `src/db/DanmakuRepository.js` 与 `src/db/danmakuApi.js` 中为 `/db/danmaku` 增加：

- 查询参数 `session_id`（或 `session`）
- Repository 过滤条件：`session_id = @sessionId`
- 用于 WebUI 从场次列表跳转到该场次弹幕

该改动很小，向后兼容；不传参数时行为不变。

### 5.3 可选：是否只看被拒绝

当前 `accepted` 字段在 API 未暴露为过滤条件。可增加参数 `accepted`：

- `accepted=1` 只看已接受
- `accepted=0` 只看被拒绝
- 不传则全部

### 5.4 可选：元数据 / 原始 JSON 详情

现有 `/db/danmaku` 已返回 `metadata`（由 `metadata_json` 解析而来）。WebUI 前端直接展示即可，无需后端改动。

### 5.5 高频弹幕 API（阶段 3）

在 `DanmakuRepository` 与 `danmakuApi.js` 中新增：

- `GET /db/hot-danmaku`：返回 `hot_danmaku` 列表，支持 `role/status/text/windowHours/minCount/limit/offset`
- `POST /db/hot-danmaku/scan`：手动扫描 `danmaku` 并更新高频弹幕表
- `POST /db/hot-danmaku/:id/generate`：生成/重新生成该条音频，成功后回填 `audio_path`
- `GET /db/hot-danmaku/:id/audio`：返回音频文件流，供试听

写操作（`POST`）必须校验 `X-DB-Token`；即使 `readToken` 为空，也建议在本机监听前提下才允许。

### 5.6 可选：缓存/任务 API

如果保留通用缓存表：

- `GET /db/cache`：返回 `tts_audio_cache` 列表
- `GET /db/cache/stats`：返回缓存汇总
- `GET /db/hot-jobs`：返回历史任务列表

这些接口不是高频弹幕核心流程，可作为后续扩展。

### 5.7 路由优先级

现有路由顺序建议：

1. `/health` 和 `/db/*` 保持原逻辑（含新增 `/db/hot-danmaku/*`）
2. `/webui/*` 和 `/` 静态页面
3. 其他非 `/tts` 路径返回 404

注意：不要占用 `/tts` 或 `/db/*` 路径。

## 6. 前端实现要点

### 6.1 文件职责

| 文件 | 职责 |
| --- | --- |
| `webui/index.html` | 页面骨架、导航标签、各面板容器 |
| `webui/style.css` | 布局、表格、标签、卡片、响应式 |
| `webui/app.js` | API 封装、Token 管理、路由/标签切换、渲染函数、分页与筛选 |

### 6.2 API 封装示例

```js
async function api(path, { method = 'GET', params = {}, body } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = {};
  const token = localStorage.getItem('db_token') || '';
  if (token) headers['X-DB-Token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    showTokenPrompt();
    throw new Error('需要数据库访问令牌');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}
```

### 6.3 时间格式化

所有时间字段为 epoch 毫秒，前端统一用 `new Date(ms).toLocaleString()` 展示，避免后端时区争议。

### 6.4 状态标签

将 `tts_status` 映射为彩色标签：

- `played` / `cache_hit` / `disk_cache_hit`：绿色
- `accepted` / `queued` / `synthesizing`：蓝色/灰色
- `skipped`：橙色
- `error`：红色

高频弹幕 `status` 映射：

- `pending`：灰色
- `generating`：蓝色（可加动画）
- `ready`：绿色
- `error`：红色

### 6.5 安全

- 所有渲染使用 `textContent` 或转义函数，避免把弹幕文本当 HTML 注入。
- 不引入 `eval` / `innerHTML` 拼接用户数据。
- 静态服务只读；高频弹幕的生成/重新生成通过受控 API 完成，不直接暴露文件系统写接口。
- 写操作（扫描、生成）需要 Token，并在前端做二次确认。

### 6.6 简易波形图

- 使用 Canvas 2D 绘制，不引入外部库。
- 步骤：
  1. `fetch('/db/hot-danmaku/:id/audio')` 获取 `ArrayBuffer`。
  2. `new AudioContext().decodeAudioData(arrayBuffer)` 解码。
  3. 取音频数据，按画布宽度分桶，计算每个桶的峰值/平均值。
  4. 绘制上下对称波形。
  5. 解码失败时隐藏 Canvas，仅保留 `<audio>` 播放器。
- 重新生成后重新拉取音频并重绘波形。


## 7. 实施步骤

### 阶段 A：最小可用（MVP）

| 工作项 | 内容 | 验收标准 |
| --- | --- | --- |
| A1 | 新增 `webui/index.html`、`style.css`、`app.js` 骨架 | 浏览器打开 `http://127.0.0.1:8899/webui/` 能看到页面 |
| A2 | `src/index.js` 增加静态文件服务 | `/webui/*` 可访问，路径穿越被拒绝 |
| A3 | 实现总览页 | 能显示数据库健康与统计卡片 |
| A4 | 实现弹幕页 | 能分页、按文本/用户/角色/状态筛选 |
| A5 | 实现用户页与用户时间线 | 能查看观众排行和单用户历史弹幕 |
| A6 | 实现场次页与热句统计页 | 能查看场次列表和热句排行 |
| A7 | 实现高频弹幕页（依赖阶段 3 API） | 能列出高频弹幕、扫描、生成/重新生成、试听 |

### 阶段 B：体验增强

| 工作项 | 内容 | 验收标准 |
| --- | --- | --- |
| B1 | 后端增加 `session_id`、`accepted` 过滤 | 场次可跳转到对应弹幕；可只看被拒弹幕 |
| B2 | Token 输入与持久化 | 配置 `readToken` 后 WebUI 可正常访问 |
| B3 | 表格列自定义/展开详情 | 长文本和 metadata 可查看 |
| B4 | 空状态、错误提示、加载状态 | 无数据库/无数据时界面友好 |
| B5 | 基础响应式样式 | 窄屏下表格可横向滚动 |
| B6 | 高频弹幕生成/重新生成交互 | 按钮状态、二次确认、生成中提示、失败展示 |

### 阶段 C：后续可选

| 工作项 | 内容 | 验收标准 |
| --- | --- | --- |
| C1 | CSV/JSON 导出按钮 | 当前筛选结果可导出 |
| C2 | 简单统计图表（按小时/按角色） | 总览页增加柱状图/折线图 |
| C3 | 自动刷新 | 总览/热句/高频弹幕可定时刷新 |
| C4 | 波形图增强 | 播放进度联动、缩放、多轨对比 |

## 8. 安全与运维

- **仅本机访问**：继续沿用 `server.host=127.0.0.1`；如需远程访问，必须设置访问令牌，并自行评估风险。
- **只读为主 + 受控写操作**：普通查看全部只读；只有“扫描高频弹幕”和“生成/重新生成音频”是写操作，并且必须带 Token。
- **数据库并发**：SQLite 已启用 WAL，WebUI 查询不会阻塞写入；但应避免高频自动刷新导致无谓查询。
- **静态文件**：不缓存敏感数据；页面本身不包含数据库内容，数据全部通过 API 获取。
- **备份**：WebUI 不替代 `npm run db:backup`；数据库维护仍按原计划执行。

## 9. 验收清单

- [ ] `npm run check` 通过。
- [ ] 不修改 `config.json` 时，启动服务后访问 `http://127.0.0.1:8899/webui/` 能看到 WebUI。
- [ ] 总览页能显示数据库统计；数据库未启用时显示明确提示。
- [ ] 弹幕页能按文本、用户名、角色、状态、时间范围查询并分页。
- [ ] 用户页能进入单个用户时间线。
- [ ] 场次页能列出直播场次；点击后能跳转到对应场次弹幕（若 B1 已完成）。
- [ ] 热句页能按窗口和最低次数显示高频弹幕。
- [ ] 高频弹幕页能按规则显示高频弹幕、状态和音频地址。
- [ ] 高频弹幕页能手动扫描、生成/重新生成音频，并回填地址。
- [ ] 每条高频弹幕都有独立“重新生成”按钮。
- [ ] 试听模态框能播放音频，并显示简易波形图。
- [ ] 配置访问令牌后，WebUI 能输入 Token 并正常访问；不输入时得到 401 提示。
- [ ] 页面不出现 XSS 问题（弹幕文本按纯文本渲染）。
- [ ] 除扫描和生成/重新生成外，不提供其他数据修改/删除入口。

## 10. 工作量估计（供参考）

| 阶段 | 预计工作量 |
| --- | --- |
| A（MVP） | 1 个完整开发会话 |
| B（体验增强） | 0.5~1 个会话 |
| C（后续可选） | 按需评估 |

> 本文档为计划稿，实施时可根据实际情况调整页面细节；核心原则是：**查看为主、高频弹幕受控生成、轻量、本地优先、复用现有 HTTP 服务**。
