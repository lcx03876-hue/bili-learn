#!/usr/bin/env node
// bili-learn — 把 B 站视频的**官方 AI 字幕**变成可检索的学习材料，并把板书看进笔记里。
//
// 设计原则：
//   1) 零依赖：只用 Node 内置模块（>=22）+ 机器上已有的 Chrome/Edge
//   2) 本地优先：登录态、字幕、抓帧、账本全部落在你自己机器上
//   3) 不绑定模型：本工具**不调用任何 LLM**——它产出转写/关键帧/提示词，由你自己的 agent 或人来看
//   4) 成本可见：读图前先算钱，超预算自动降级
//
// 用法见 README.md；子命令列表：bili-learn help
import { readFile, writeFile, mkdir, appendFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { ensureBrowser, findBrowser, browserVersion, listTargets, newPage, closeTarget, DEFAULT_PORT } from '../src/cdp.mjs';
import {
  attach, loginState, searchVideos, videoInfo, fetchTranscript, transcriptToMarkdown,
  playVideo, captureLoginQr, waitForLogin, parseDuration, DEFAULT_PORT as PORT,
} from '../src/bili.mjs';
import { pickKeyFrames, stampToSeconds, stampOf } from '../src/frames.mjs';
import { estimateVisionYuan, estimateDigestYuan, readAccountUsage, today } from '../src/cost.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'data');
const CONFIG_FILE = join(DATA, 'config.json');
const SPEND_FILE = join(DATA, 'spend.json');
const OUT_DIR = join(DATA, 'out');
const FRAMES_DIR = join(DATA, 'frames');

const DEFAULT_CONFIG = {
  port: 9333,
  profileDir: join(DATA, 'profile'),
  rate: 1.5,
  mute: true,
  dailyBudgetYuan: 1,
  frames: {
    sampleMs: 6000,
    minGapMs: 8000,
    maxFrames: 40,
    changeThreshold: 3,
    width: 1600,
    height: 900,
    quality: 0.9,
    visionTokensPerImage: 1300,
  },
  cost: { priceInIdle: 1, priceOutIdle: 4, priceInPeak: 2, priceOutPeak: 8, charsPerToken: 1.4, digestOverheadTokens: 12000, digestOutputTokens: 2500 },
};

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      const key = a.slice(2);
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
const flags = parseFlags(argv.slice(1));
const say = (...p) => console.log(...p);
const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return d; } };

async function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...(await readJson(CONFIG_FILE, {})) };
  if (!existsSync(CONFIG_FILE)) { await mkdir(DATA, { recursive: true }); await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
  return cfg;
}
function isPeakNow(cfg, d = new Date()) {
  const peak = cfg.peak ?? { weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00'], ['14:00', '18:00']] };
  if (!(peak.weekdays ?? []).includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  const mod = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  return (peak.windows ?? []).some(([s, e]) => mins >= mod(s) && mins < mod(e));
}

/** 极简本地账本：今天已占用多少、明细是什么。 */
async function loadSpend() {
  const s = await readJson(SPEND_FILE, null);
  if (!s || s.day !== today()) return { day: today(), entries: [] };
  return s;
}
const committedYuan = (s) => (s.entries ?? []).reduce((a, e) => a + (e.estYuan ?? 0), 0);
async function saveSpend(s) { await mkdir(DATA, { recursive: true }); await writeFile(SPEND_FILE, JSON.stringify(s, null, 2), 'utf8'); }

function parseTarget(input) {
  const s = String(input ?? '');
  const bv = (s.match(/BV[0-9A-Za-z]+/) ?? [])[0];
  if (!bv) return null;
  const p = Number((s.match(/[?&]p=(\d+)/) ?? [])[1] ?? flags.p ?? 1);
  return { bvid: bv, p };
}

// ───────────────────────────── 子命令 ─────────────────────────────

async function cmdDoctor() {
  const cfg = await loadConfig();
  const out = [];
  out.push(`Node            ${process.version}${Number(process.versions.node.split('.')[0]) >= 22 ? ' ✓' : ' ✗（需要 >= 22）'}`);
  let browser = null;
  try { browser = findBrowser(); } catch { /* 没找到 */ }
  out.push(`浏览器          ${browser ?? '✗ 没找到 Chrome/Edge'}`);
  const v = await browserVersion(cfg.port);
  out.push(`CDP :${cfg.port}        ${v ? `✓ 已在运行（${v.Browser}）` : '— 未运行（首个命令会自动拉起）'}`);
  out.push(`数据目录        ${DATA}`);
  out.push(`配置            ${existsSync(CONFIG_FILE) ? CONFIG_FILE : '（尚未创建，跑任意命令会生成默认配置）'}`);
  const spend = await loadSpend();
  out.push(`今日预算        ¥${cfg.dailyBudgetYuan}，已占用 ¥${committedYuan(spend).toFixed(4)}（${spend.entries.length} 笔）`);
  const acct = await readAccountUsage();
  out.push(`账号账本        ${acct.error ? '（未检测到 DSH 账本；非 DSH 用户可忽略）' : `余额 ¥${acct.lastBalance}，今日 ¥${acct.todayUsage}`}`);
  say(out.join('\n'));
}

async function cmdLogin() {
  const cfg = await loadConfig();
  const { cdp } = await attach({ port: cfg.port, profileDir: cfg.profileDir });
  const before = await loginState(cdp).catch(() => null);
  if (before?.isLogin) return say(`已登录：${before.uname}（mid ${before.mid}）`);
  const file = join(OUT_DIR, 'login-qr.png');
  const qr = await captureLoginQr(cdp, file);
  say(`未登录。用 B 站手机客户端扫码：${qr.file}`);
  const res = await waitForLogin(cdp, { timeoutMs: Number(flags.timeout ?? 300) * 1000 });
  say(res.ok ? `登录成功：${res.uname}` : `等待超时：${JSON.stringify(res)}`);
}

async function cmdSearch() {
  const cfg = await loadConfig();
  const kw = flags._.join(' ');
  if (!kw) return say('用法: bili-learn search <关键词> [--limit 12]');
  const { cdp } = await attach({ port: cfg.port, profileDir: cfg.profileDir, reusePage: 'search.bilibili.com' });
  const items = await searchVideos(cdp, kw, { limit: Number(flags.limit ?? 12) });
  for (const r of items) say(`${r.bvid}  ${r.durText.padStart(8)}  ${r.title.slice(0, 60)}`);
  say(`\n（${items.length} 条。下一步：bili-learn transcript <bvid>）`);
}

async function cmdTranscript() {
  const cfg = await loadConfig();
  const target = parseTarget(flags._[0] ?? flags.bvid);
  if (!target) return say('用法: bili-learn transcript <bvid|URL> [--p N]');
  const { cdp } = await attach({ port: cfg.port, profileDir: cfg.profileDir, reusePage: 'bilibili.com' });
  const info = await fetchTranscript(cdp, target.bvid, { p: target.p });
  if (!info.lines?.length) return say(`没有字幕轨（code=${info.code ?? '-'} ${info.note ?? info.message ?? ''}）——本工具依赖官方字幕，不做语音识别。`);
  await mkdir(join(OUT_DIR, 'transcripts'), { recursive: true });
  const file = join(OUT_DIR, 'transcripts', `${target.bvid}${info.pageCount > 1 ? `-P${info.p}` : ''}.md`);
  await writeFile(file, transcriptToMarkdown(info, info.lines), 'utf8');
  const pct = Math.round((info.coverage ?? 1) * 100);
  say(`${info.title}`);
  say(`  ${info.lineCount} 行 / 覆盖 ${pct}%${pct < 80 ? '  ⚠️ 字幕轨没覆盖全片，转写不完整' : ''}`);
  say(`  → ${file}`);
  const est = estimateDigestYuan(transcriptToMarkdown(info, info.lines).length, cfg, { peak: isPeakNow(cfg) });
  say(`  （若交给 LLM 消化，约 ¥${est.toFixed(4)} —— 用 bili-learn prompt ${file} 生成提示词）`);
}

async function cmdFrames() {
  const cfg = await loadConfig();
  const dirArg = flags.dir ?? flags._[0];
  const budget = Number(flags['budget-yuan'] ?? cfg.dailyBudgetYuan);
  const spend = await loadSpend();
  const remaining = Math.max(0, budget - committedYuan(spend));
  const peak = isPeakNow(cfg);
  const perImage = estimateVisionYuan(1, cfg, { peak });

  const dirs = (await readdir(FRAMES_DIR, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const target = dirArg ? [String(dirArg).replace(/^.*[\\/]/, '')] : dirs.slice(-1);
  if (!target.length || !target[0]) return say(`没有抓帧目录（${FRAMES_DIR}）。抓帧由 watch/loop 产生，或你自己放 .jpg 进去。`);

  const want = Math.max(1, Number(flags.want ?? 8));
  const out = [];
  for (const dir of target) {
    const full = join(FRAMES_DIR, dir);
    const files = (await readdir(full).catch(() => [])).filter((f) => f.endsWith('.jpg')).sort();
    if (!files.length) { out.push(`（${dir} 里没有 .jpg）`); continue; }
    const rows = files.map((f) => {
      const t = stampToSeconds(f.replace('.jpg', '').split('-')[0]);
      return { f, t: Number.isFinite(t) ? t : 0, heldSec: 0 };
    });
    for (let i = 0; i < rows.length; i++) {
      const next = rows[i + 1];
      rows[i].heldSec = Math.max(0, next ? (next.t >= rows[i].t ? next.t - rows[i].t : 60) : 60);
    }
    const affordable = perImage > 0 ? Math.floor(remaining / perImage) : want;
    const capped = Math.min(want, rows.length);
    const picks = pickKeyFrames(rows, Math.min(capped, Math.max(0, affordable))).slice(0, Math.min(capped, Math.max(0, affordable)));
    out.push(`=== ${dir}（共 ${rows.length} 张，想读 ${want}）===`);
    if (!picks.length) { out.push(`  ⛔ 今日预算已用满（¥${committedYuan(spend).toFixed(4)}/¥${budget}）：先消化已有材料，或调 --budget-yuan。`); continue; }
    if (affordable < capped) out.push(`  ⚠️ 额度只够 ${picks.length} 张：按"在场最久优先"降级。`);
    else if (rows.length < want) out.push(`  注：目录里只有 ${rows.length} 张。`);
    for (const r of picks) out.push(`  ${join(full, r.f)}   @${stampOf(r.t)}  在场 ${r.heldSec}s`);
    const cost = estimateVisionYuan(picks.length, cfg, { peak });
    out.push(`  读这 ${picks.length} 张 ≈ ¥${cost.toFixed(4)}｜今日余量 ¥${remaining.toFixed(4)} → 读后剩 ¥${(remaining - cost).toFixed(4)}`);
    if (flags.book) {
      spend.entries = (spend.entries ?? []).filter((e) => e.key !== `vision:${dir}`);
      spend.entries.push({ key: `vision:${dir}`, kind: 'vision', dir, images: picks.length, estYuan: cost, at: new Date().toISOString() });
    }
  }
  if (flags.book) { await saveSpend(spend); out.push('\n已记入本工具账本（data/spend.json）；撤销：bili-learn spend --clear-vision'); }
  if (flags.unbook || flags['clear-vision']) {
    const s = await loadSpend();
    const before = s.entries.length;
    s.entries = s.entries.filter((e) => e.kind !== 'vision');
    await saveSpend(s);
    out.push(`\n已撤销 ${before - s.entries.length} 笔读图占用。`);
  }
  say(out.join('\n'));
}

async function cmdWatch() {
  const cfg = await loadConfig();
  const target = parseTarget(flags._[0] ?? flags.bvid);
  if (!target) return say('用法: bili-learn watch <bvid|URL> [--rate 1.5] [--mute] [--max-min 60]');
  const { cdp } = await attach({ port: cfg.port, profileDir: cfg.profileDir, reusePage: 'bilibili.com' });
  say('开始真实播放（会占满这一条视频的时长）。⚠️ 自动化播放属于 B 站用户协议的灰区，请自行斟酌频率与账号风险。');
  const res = await playVideo(cdp, target.bvid, {
    p: target.p,
    rate: Number(flags.rate ?? cfg.rate),
    mute: flags.unmute ? false : cfg.mute,
    pollMs: 2000,
    maxWallMinutes: Number(flags['max-min'] ?? 240),
    onTick: (t) => { if (Math.floor(t.t) % 60 < 2) say(`  ${Math.floor(t.t)}s / ${Math.floor(t.dur)}s ${t.quality ?? ''}`); },
  });
  say(`结果：${res.status}（看了 ${res.watched ?? 0}s）`);
}

/** 生成"消化提示词"：本工具不调用模型，只把提示词和数据准备好，交给你的 agent / 人。 */
async function cmdPrompt() {
  const cfg = await loadConfig();
  const file = flags._[0] ?? flags.file;
  if (!file) return say('用法: bili-learn prompt <transcript.md> [--with-frames <dir>]');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (!text) return say(`读不到 ${file}`);
  const est = estimateDigestYuan(text.length, cfg, { peak: isPeakNow(cfg) });
  say(`# 消化任务（把下面这段交给你的模型/agent；本工具不代为调用）\n`);
  say(`要求：按下面结构写一篇笔记，只保留可复用的信息，不要复述视频。`);
  say(`- 一句话结论 / 核心内容（每条带 [HH:MM:SS] 时间戳）/ 可复用要点 / 术语 / 存疑\n`);
  say(`输入（${text.length} 字，预估模型成本约 ¥${est.toFixed(4)}）：\n`);
  say('```markdown');
  say(text.length > 40000 ? text.slice(0, 40000) + '\n…（已截断，建议分段消化）' : text);
  say('```');
  if (flags['with-frames']) say(`\n板书帧：先跑 bili-learn frames --dir ${flags['with-frames']} --pick --want 6 挑关键帧，再把选中的图一起给它。`);
}

async function cmdSpend() {
  const cfg = await loadConfig();
  const s = await loadSpend();
  if (flags['clear-vision']) {
    const before = s.entries.length;
    s.entries = s.entries.filter((e) => e.kind !== 'vision');
    await saveSpend(s);
    return say(`已撤销 ${before - s.entries.length} 笔读图占用。`);
  }
  if (flags['add-yuan']) {
    s.entries.push({ key: `manual:${Date.now()}`, kind: 'manual', estYuan: Number(flags['add-yuan']), at: new Date().toISOString() });
    await saveSpend(s);
  }
  say(`日期 ${s.day}　预算 ¥${cfg.dailyBudgetYuan}　已占用 ¥${committedYuan(s).toFixed(4)}　余量 ¥${Math.max(0, cfg.dailyBudgetYuan - committedYuan(s)).toFixed(4)}`);
  for (const e of s.entries) say(`  · ¥${Number(e.estYuan).toFixed(4)}  ${e.kind === 'vision' ? `${e.images} 张图 (${e.dir})` : (e.kind ?? '')}  ${e.at ?? ''}`);
  const acct = await readAccountUsage();
  if (!acct.error) say(`\n（账号账本：余额 ¥${acct.lastBalance}，今日总消费 ¥${acct.todayUsage}）`);
}

const commands = { doctor: cmdDoctor, login: cmdLogin, search: cmdSearch, transcript: cmdTranscript, frames: cmdFrames, watch: cmdWatch, prompt: cmdPrompt, spend: cmdSpend };

if (commands[cmd]) {
  await commands[cmd]();
  process.exit(0);
} else {
  say(`bili-learn — 把 B 站官方字幕变成学习材料（零依赖，本地优先，不调用任何模型）

  doctor                     环境自检（Node / 浏览器 / 数据目录 / 预算 / 账号账本）
  login                      扫码登录（独立 profile，只存在本机）
  search <关键词>            搜视频（列出 bvid / 时长 / 标题）
  transcript <bvid|URL>      取官方 AI 字幕 → data/out/transcripts/*.md（含覆盖率）
  frames --dir <名字> --pick  从抓帧里挑关键帧 + 算读图成本（--want N / --book / --budget-yuan）
  watch <bvid|URL>           真实播放（--rate / --mute / --max-min）⚠️ 用户协议灰区
  prompt <transcript.md>     生成"消化提示词"，交给你的模型（本工具不代调）
  spend [--add-yuan N]       看/记本地账本（--clear-vision 撤读图占用）

数据都在 ${DATA}（登录态在 data/profile，勿外传）。详见 README.md。`);
}
