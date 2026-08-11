/**
 * 阶段 7 验证：假定中间件(7788)已由外部启动（Genie 由中间件自动拉起，
 * 访问日志落在 logs/genie_auto.*.log），依次验证功能、文本处理、
 * 中日文路由、长文本与连续切换，并断言日志。
 *
 * 用法：
 *     node scripts/phase7_verify.mjs <genieOutLog> <genieErrLog> <middlewareLog>
 */

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [genieOutFile, genieErrFile, mwLogFile] = process.argv.slice(2);
if (!genieOutFile || !genieErrFile || !mwLogFile) {
  console.error('用法: node scripts/phase7_verify.mjs <genieOutLog> <genieErrLog> <middlewareLog>');
  process.exit(2);
}

const BASE = 'http://127.0.0.1:7788/tts';
const LONG_TEXT =
  '二阶堂希罗说今天天气真不错，弹幕姬机器人已经开始工作了，' +
  '直播间里的各位观众大家好，感谢你们的陪伴和支持，' +
  '接下来我们会继续播报更多有趣的弹幕内容，请大家多多期待，' +
  '如果有什么想说的话也欢迎随时发送到直播间，' +
  '让我们一起来享受这段快乐的时光吧，谢谢大家！';

const requests = [
  { label: 'ema 中文', text: '樱羽艾玛说你好，欢迎来到直播间', expect: 202 },
  { label: 'hiro 中文', text: '二阶堂希罗说大家好', expect: 202 },
  { label: 'tomori 中文', text: '高松灯说今天天气不错', expect: 202 },
  { label: '诗歌剧 中文', text: '诗歌剧说欢迎来到直播间', expect: 202 },
  { label: 'sherry 中文', text: '橘雪莉说大家好呀', expect: 202 },
  { label: 'hiro 日语', text: '二阶堂希罗说こんにちは、先生', expect: 202 },
  { label: 'hiro 长文本', text: LONG_TEXT, expect: 202 },
  { label: '屏蔽词拒绝', text: '樱羽艾玛说测试屏蔽词', expect: 403 },
  { label: '开头过滤拒绝', text: '已断开连接', expect: 403 },
  { label: '替换与角色别名', text: 'NTE0说这是一条替换测试', expect: 202 },
];

const results = [];
for (const req of requests) {
  const res = await fetch(`${BASE}?text=${encodeURIComponent(req.text)}`);
  const ok = res.status === req.expect;
  results.push({ ...req, actual: res.status, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${req.label}: HTTP ${res.status} (expect ${req.expect})`);
}

console.log('[wait] 等待合成与播放完成（最多 150 秒）...');
await sleep(150000);

const genieLog = `${readFileSync(genieOutFile, 'utf8')}\n${readFileSync(genieErrFile, 'utf8')}`;
const mwLog = readFileSync(mwLogFile, 'utf8');

const tts200 = (genieLog.match(/POST \/tts HTTP\/1\.1" 200/g) ?? []).length;
const ttsFail = (mwLog.match(/TTS 合成失败/g) ?? []).length;
const playerErr = (mwLog.match(/播放器错误/g) ?? []).length;
const zhSynthesized = (mwLog.match(/合成: [^（]+（语言 zh）/g) ?? []).length;
const jpSynthesized = (mwLog.match(/合成: \w+（语言 jp）/g) ?? []).length;

const expectedTts = requests.filter((r) => r.expect === 202).length;
const checks = [
  ['Genie /tts 200 数量', tts200 === expectedTts, `${tts200}/${expectedTts}`],
  ['中间件无 TTS 合成失败', ttsFail === 0, `${ttsFail}`],
  ['中间件无播放器错误', playerErr === 0, `${playerErr}`],
  ['中文合成次数', zhSynthesized === 7, `${zhSynthesized}/7`],
  ['日语合成次数', jpSynthesized === 1, `${jpSynthesized}/1`],
];

const preloadTime = mwLog.match(/\[([^\]]+)\] \[INFO\] 开始预加载/)?.[1];
const doneTime = mwLog.match(/\[([^\]]+)\] \[INFO\] 角色预加载完成/)?.[1];
if (preloadTime && doneTime) {
  const preloadSeconds = Math.round((new Date(doneTime) - new Date(preloadTime)) / 1000);
  console.log(`INFO 首次预加载耗时: ${preloadSeconds}s`);
}

let allPass = results.every((r) => r.ok);
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (!pass) allPass = false;
}

console.log(allPass ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(allPass ? 0 : 1);
