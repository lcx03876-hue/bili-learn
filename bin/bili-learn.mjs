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

import { ensureBrowser, findBrowser, browserVersion, listTargets, newPage, closeTarget, closeBrowser, DEFAULT_PORT } from '../src/cdp.mjs';
import {
  attach, loginState, searchVideos, videoInfo, fetchTranscript, transcriptToMarkdown,
  playVideo, captureLoginQr, waitForLogin, parseDuration, DEFAULT_PORT as PORT,
} from '../src/bili.mjs';
import { pickKeyFrames, stampToSeconds, stampOf, createFrameGrabber, framesDirFor } from '../src/frames.mjs';
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
  // 注意：这里的键名与 src/frames.mjs 的 createFrameGrabber 参数**逐字对应**
  // （曾经用过 sampleMs，结果改了配置不生效——配置键名和库参数名不一致是这类工具的经典坑）
  frames: {
    intervalMs: 6000,        // 多久采一次缩略图做差分
    minGapMs: 8000,          // 两张之间至少隔多久（实际会被自动放大到铺满整片，见 watch）
    maxFrames: 40,           // 每条视频最多存几张
    changeThreshold: 3,      // 画面变化阈值，越大越省
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
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq > 0) { out[body.slice(0, eq)] = body.slice(eq + 1); continue; }   // 支持 --want=8（很多人默认这么写）
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[body] = next; i++; } else out[body] = true;
    } else out._.push(a);
  }
  return out;
}
const flags = parseFlags(argv.slice(1));
const say = (...p) => console.log(...p);
// 读 JSON：必须容忍 BOM。Windows 记事本 / PowerShell 的 `Set-Content -Encoding UTF8` 都会写 BOM，
// 而 JSON.parse 遇到 BOM 直接抛错 → 若在 catch 里回退成默认值，用户手工编辑的整份配置会被**静默重置**。
// （这个坑是真实踩到的：给 config.json 加了一个自定义键，跑一条命令后键没了、配置回到默认。）
const readJson = async (p, d) => {
  try {
    let s = await readFile(p, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return JSON.parse(s);
  } catch { return d; }
};

/** 深合并：配置里新增的嵌套键（如 frames.intervalMs）对老配置文件也要生效。
 *  踩过的坑：`{...默认, ...文件}` 会把整个 frames 对象替换掉，于是新键全是 undefined——
 *  用户改了配置没反应、日志打印 "undefinedms"，而且完全不报错。 */
function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object')
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

async function loadConfig() {
  const onDisk = await readJson(CONFIG_FILE, null);
  const merged = deepMerge(DEFAULT_CONFIG, onDisk ?? {});
  const cfg = { ...merged };
  // 环境变量覆盖：方便指向一个已登录的 profile 做复用/验证
  if (process.env.BILI_LEARN_PROFILE) cfg.profileDir = process.env.BILI_LEARN_PROFILE;
  if (process.env.BILI_LEARN_PORT) cfg.port = Number(process.env.BILI_LEARN_PORT);
  // 首次运行，或默认值里有文件里缺的键 → 写回（让新增配置项在文件里可见；不删用户已有的键）
  if (!onDisk || JSON.stringify(merged) !== JSON.stringify(onDisk)) {
    await mkdir(DATA, { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  }
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

/**
 * 连上浏览器，并**确保页面落在 bilibili.com 源上**。
 *
 * 坑（踩过）：新开标签页是 about:blank，在它上面做 in-page fetch 会被 CORS 拒绝
 * （`TypeError: Failed to fetch`）。B 站的接口必须从 bilibili.com 的页面上下文里发，
 * 所以这里先检查 location，必要时先导航到首页。
 */
async function attachBili(cfg, reusePage = 'bilibili.com') {
  const session = await attach({ port: cfg.port, profileDir: cfg.profileDir, reusePage });
  const href = await session.cdp.evaluate('location.href').catch(() => '');
  if (!/bilibili\.com/.test(href)) await session.cdp.navigate('https://www.bilibili.com/').catch(() => {});
  return session;
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
  // 必须用 attachBili：新开的标签页是 about:blank 源，在它上面 fetch nav 接口会被 CORS 拒 →
  // loginState 会误判成"未登录"，于是每次 login 都再走一遍扫码流程（实测踩到）。
  const { cdp } = await attachBili(cfg);
  const before = await loginState(cdp).catch(() => null);
  if (before?.isLogin) return say(`✓ 已登录：${before.uname}（mid ${before.mid}）——登录态在 ${cfg.profileDir}，不用再扫。`);
  await mkdir(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, 'login-qr.png');
  // 注意返回形状是 { file, clipped, selector }——**不含** width/height
  // （曾经按 {file,width,height} 用，结果输出里出现 "NaN×NaN"：猜库的返回形状是这类工具最常见的 bug）
  const qr = await captureLoginQr(cdp, file);
  say(`未登录。二维码已存到 ${file}${qr.clipped ? `（已裁到二维码区域：${qr.selector}）` : '（未定位到二维码元素，存的是整页截图）'}`);
  say('用 B 站手机客户端扫码；也可以直接在浏览器窗口里扫。');
  const res = await waitForLogin(cdp, { timeoutMs: Number(flags.timeout ?? 300) * 1000 });
  say(res.ok ? `✓ 登录成功：${res.uname}（登录态保存在 ${cfg.profileDir}，下次不用再扫）` : `等待超时（${JSON.stringify(res)}）。可以再跑一次 bili-learn login。`);
}

async function cmdSearch() {
  const cfg = await loadConfig();
  const kw = flags._.join(' ');
  if (!kw) return say('用法: bili-learn search <关键词> [--limit 12]');
  const { cdp } = await attachBili(cfg, 'search.bilibili.com');
  const items = await searchVideos(cdp, kw, { limit: Number(flags.limit ?? 12) });
  for (const r of items) say(`${r.bvid}  ${r.durText.padStart(8)}  ${r.title.slice(0, 60)}`);
  say(`\n（${items.length} 条。下一步：bili-learn transcript <bvid>）`);
}

async function cmdTranscript() {
  const cfg = await loadConfig();
  const target = parseTarget(flags._[0] ?? flags.bvid);
  if (!target) return say('用法: bili-learn transcript <bvid|URL> [--p N]');
  const { cdp } = await attachBili(cfg);
  const info = await fetchTranscript(cdp, target.bvid, { p: target.p });
  if (!info.lines?.length) {
    // 412 是 B 站风控：**未登录的干净 profile 连 view/subtitle 接口都会被拒**（实测：指纹 cookie 有了也照拒）。
    const hint = [undefined, 0, -999, -412, -404].includes(info.code)
      ? '\n提示：code=-999/-412 通常是被风控拦下（返回 HTML 而非 JSON）。**先跑 `bili-learn login` 扫码登录**再试。'
      : '';
    return say(`没有字幕轨（code=${info.code ?? '-'} ${info.note ?? info.message ?? ''}）${hint}\n本工具依赖官方字幕，不做语音识别。`);
  }
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

  // 单独撤销读图占用（不需要 --pick）
  if (flags.unbook) {
    const s = await loadSpend();
    const before = s.entries.length;
    s.entries = s.entries.filter((e) => e.kind !== 'vision');
    await saveSpend(s);
    return say(`已撤销 ${before - s.entries.length} 笔读图占用。`);
  }

  const dirs = (await readdir(FRAMES_DIR, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  // ── 只列目录（默认）：不做任何成本计算，方便先看看手上有什么 ───────────────
  if (!flags.pick) {
    if (!dirs.length) return say(`还没有抓帧（${FRAMES_DIR}）。先跑 bili-learn watch <bvid> 抓帧，或把 .jpg 放进去。`);
    const out = [];
    for (const dir of dirs) {
      if (dirArg && !dir.startsWith(String(dirArg))) continue;
      const full = join(FRAMES_DIR, dir);
      const files = (await readdir(full).catch(() => [])).filter((f) => f.endsWith('.jpg')).sort();
      const mb = files.length ? (await Promise.all(files.map(async (f) => (await stat(join(full, f)).catch(() => ({ size: 0 }))).size))).reduce((a, b) => a + b, 0) / 1024 / 1024 : 0;
      out.push(`${dir}  ${files.length} 张  ${mb.toFixed(1)}MB`);
      if (flags.all) for (const f of files) out.push(`  ${join(full, f)}`);
    }
    out.push('\n挑关键帧并算钱：frames --pick [--dir <名字>] [--want N] [--book]');
    return say(out.join('\n'));
  }

  // ── 读图预算闸门：挑关键帧 → 先算钱 → 再决定读几张 ─────────────────────────
  const budget = Number(flags['budget-yuan'] ?? cfg.dailyBudgetYuan);
  const spend = await loadSpend();
  const remaining = Math.max(0, budget - committedYuan(spend));
  const peak = isPeakNow(cfg);
  const perImage = estimateVisionYuan(1, cfg, { peak });
  const out = [];

  // 默认只处理**最近抓的那个目录**：一次消化通常只针对一条视频，
  // 而且用户刚跑完 watch，期望的就是刚抓的那条（按 mtime，而不是目录名字母序）。
  let target;
  if (dirArg) {
    target = [String(dirArg).replace(/^.*[\\/]/, '')];
  } else {
    let best = null;
    for (const d of dirs) {
      const st = await stat(join(FRAMES_DIR, d)).catch(() => null);
      if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { d, mtimeMs: st.mtimeMs };
    }
    target = best ? [best.d] : [];
    if (target.length && dirs.length > 1) out.push(`（未指定 --dir，默认用最近抓的 ${target[0]}；共 ${dirs.length} 个目录）`);
  }
  if (!target.length || !target[0]) return say(`没有抓帧目录（${FRAMES_DIR}）。抓帧由 watch 产生，或你自己放 .jpg 进去。`);

  const want = Math.max(1, Number(flags.want ?? 8));
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
  say(out.join('\n'));
}

/** playVideo 的状态码 → 说人话（原始状态码见 src/bili.mjs，'timeout' = 到时间上限而不是出错）。 */
const STATUS_TEXT = {
  completed: '✓ 看完了',
  timeout: '⏱ 到时间上限（--max-min），视频没放完——加 --max-min 或用 --rate 加速可续',
  stopped: '⏸ 被外部条件停止（shouldStop）',
  stalled: '⚠️ 反复卡住，已放弃（网络/限流？稍后再试）',
  'vip-bangumi': '⛔ 番剧/会员专享，非会员不可播（换了也白等）',
  unavailable: '⛔ 播不了（页面异常或稿件不可用）',
  error: '⛔ 播放出错',
};

async function cmdWatch() {
  const cfg = await loadConfig();
  const target = parseTarget(flags._[0] ?? flags.bvid);
  if (!target) return say('用法: bili-learn watch <bvid|URL> [--rate 1.5] [--mute] [--max-min 60] [--no-frames]');
  const { cdp } = await attachBili(cfg);
  say('开始真实播放。⚠️ 自动化播放属于 B 站用户协议的灰区，请自行斟酌频率与账号风险。');

  // 先拿时长：抓帧间隔要按"铺满整片"自动放大（帧数与成本不变，覆盖从开头几分钟变成整条视频）
  const info = await videoInfo(cdp, target.bvid, { p: target.p }).catch(() => null);
  const wantFrames = !flags['no-frames'];
  let grabber = null;
  if (wantFrames && info?.ok) {
    const dir = framesDirFor(FRAMES_DIR, target.bvid, target.p, info.pageCount);
    await mkdir(dir, { recursive: true });
    const sec = Number(info.duration ?? 0);
    const spread = sec > 0 ? Math.ceil((sec * 1000) / Math.max(1, cfg.frames.maxFrames)) : 0;
    const minGapMs = Math.max(Number(cfg.frames.minGapMs ?? 8000), spread);
    grabber = createFrameGrabber(cdp, {
      dir,
      intervalMs: Number(cfg.frames.intervalMs ?? 6000),
      minGapMs,
      maxFrames: Number(cfg.frames.maxFrames ?? 40),
      changeThreshold: Number(cfg.frames.changeThreshold ?? 3),
      width: Number(cfg.frames.width ?? 1600),
      height: Number(cfg.frames.height ?? 900),
      quality: Number(cfg.frames.quality ?? 0.9),
      totalSec: sec,
    });
    say(`抓帧：${dir}（每 ${cfg.frames.intervalMs}ms 采一次、间隔 ≥${Math.round(minGapMs / 1000)}s、最多 ${cfg.frames.maxFrames} 张）`);
  }

  let lastShown = -99;
  const res = await playVideo(cdp, target.bvid, {
    p: target.p,
    rate: Number(flags.rate ?? cfg.rate),
    mute: flags.unmute ? false : cfg.mute,
    pollMs: 2000,
    maxWallMinutes: Number(flags['max-min'] ?? 240),
    onTick: async (t) => {
      if (grabber) await grabber.tick(t.t).catch(() => {});
      const now = Math.floor(t.t);
      if (now - lastShown >= 60) {          // 每分钟报一次（原来用 % 60 判断，遇到跳过整点会一直不打印）
        lastShown = now;
        say(`  ${now}s / ${Math.floor(t.dur)}s ${t.quality ?? ''}${grabber ? `　已存 ${grabber.state.saved} 张` : ''}`);
      }
    },
  });

  say(`结果：${STATUS_TEXT[res.status] ?? res.status}（播放 ${Math.floor(res.watched ?? 0)}s${res.dur ? ` / 全长 ${Math.floor(res.dur)}s` : ''}${res.quality ? `　${res.quality}` : ''}）`);
  if (grabber) {
    say(`抓帧完成：${grabber.state.saved} 张${grabber.state.skippedReason ? `（停止原因：${grabber.state.skippedReason}）` : ''}`);
    const dirName = framesDirFor('.', target.bvid, target.p, info?.pageCount ?? 1).replace(/^[.\\/]+/, '');
    if (grabber.state.saved === 0) say('一张都没存：画面几乎没变（阈值偏高），或播放没真正开始。');
    else say(`下一步：bili-learn frames --pick --dir ${dirName} --book`);
  }
  say('（浏览器留着方便你看；收工：bili-learn close）');
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

/** 关掉 CDP 浏览器（用完就收，别把窗口留在桌面上）。 */
async function cmdClose() {
  const cfg = await loadConfig();
  if (!(await browserVersion(cfg.port))) return say(`端口 ${cfg.port} 上没有运行中的浏览器`);
  // 直接在浏览器级关闭，不要为了关闭而 attach 一个新标签页（那会平白多开一个窗口）
  await closeBrowser(cfg.port, cfg.profileDir).catch(() => {});
  await sleep(600);
  say((await browserVersion(cfg.port)) ? '关闭指令已发送（浏览器可能还在退出）' : `✓ 已关闭浏览器`);
}

const commands = { doctor: cmdDoctor, login: cmdLogin, search: cmdSearch, transcript: cmdTranscript, frames: cmdFrames, watch: cmdWatch, prompt: cmdPrompt, spend: cmdSpend, close: cmdClose };

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
  close                      关掉 CDP 浏览器（用完收起窗口）

数据都在 ${DATA}（登录态在 data/profile，勿外传）。详见 README.md。`);
}
