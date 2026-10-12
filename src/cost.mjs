// 学习花费记账：真实用量读 DSH 自己的账本，未消化转写按预估占用额度。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function dshHome() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return process.env.DSH_HOME ?? join(appData, 'dsh-desktop', 'harness');
}

/** DSH 桌面端维护的账号级用量账本（包含所有会话，不只是学习）。 */
export async function readAccountUsage() {
  const file = join(dshHome(), '.dshw-usage.json');
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    return {
      file,
      date: j.date ?? null,
      todayUsage: Number(j.todayUsage ?? 0),
      lastBalance: j.lastBalance ?? null,
      history: j.history ?? {},
      events: Array.isArray(j.events) ? j.events : [],
    };
  } catch (e) {
    return { file, date: null, todayUsage: null, events: [], error: e.message };
  }
}

/** 一次"消化一篇转写"的预估花费（元）。保守估计：输入按字符数折算 + 固定开销，输出按笔记长度。 */
export function estimateDigestYuan(chars, cfg, { peak = false } = {}) {
  const c = cfg.cost ?? {};
  const charsPerToken = c.charsPerToken ?? 1.4;
  const priceIn = peak ? (c.priceInPeak ?? 2) : (c.priceInIdle ?? 1);
  const priceOut = peak ? (c.priceOutPeak ?? 8) : (c.priceOutIdle ?? 4);
  const tokensIn = chars / charsPerToken + (c.digestOverheadTokens ?? 12000);
  const tokensOut = c.digestOutputTokens ?? 2500;
  return (tokensIn * priceIn + tokensOut * priceOut) / 1e6;
}

export function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 读图（vision）的预估花费（元）。
 *
 * 为什么单独估：图是按 token 计费的，而且**比同长度文本贵得多**——一张 1280×720 的 PPT 帧
 * 大约 1300 input token（实测口径见 tools/analyze-frames.mjs）。一次读 40 张就是 5 万 token，
 * 不先算清楚，很容易在"看板书"这件事上把当天预算吃掉。
 */
export function estimateVisionYuan(images, cfg, { peak = false } = {}) {
  const c = cfg.cost ?? {};
  const perImage = Number(cfg.frames?.visionTokensPerImage ?? 1300);
  const priceIn = peak ? (c.priceInPeak ?? 2) : (c.priceInIdle ?? 1);
  return (Number(images) * perImage * priceIn) / 1e6;
}

const EMPTY = () => ({ day: today(), measuredYuan: 0, runs: [], reservations: [] });

export async function loadCost(file) {
  let data;
  try {
    let text = await readFile(file, 'utf8');
    // 记事本 / PowerShell `Set-Content -Encoding UTF8` 会写 BOM，而 JSON.parse 遇 BOM 直接抛错 →
    // 若不处理，用户手工改过的账本会被静默丢弃（回退成空账本）。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch {
    data = EMPTY();
  }
  if (data.day !== today()) data = { ...EMPTY(), note: '新的一天，额度重置' };
  data.runs ??= [];
  data.reservations ??= [];
  return data;
}

export async function saveCost(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

export function reservedYuan(cost) {
  return (cost.reservations ?? []).reduce((a, r) => a + (r.estYuan ?? 0), 0);
}

export function committedYuan(cost) {
  return (cost.measuredYuan ?? 0) + reservedYuan(cost);
}

/** 记一次消化：用账本差值算真实花费。 */
export async function recordRun(file, { label, beforeYuan, afterYuan }) {
  const cost = await loadCost(file);
  const deltaYuan = Math.max(0, Number(afterYuan) - Number(beforeYuan));
  cost.measuredYuan = (cost.measuredYuan ?? 0) + deltaYuan;
  cost.runs.push({ at: new Date().toISOString(), label, beforeYuan: Number(beforeYuan), afterYuan: Number(afterYuan), deltaYuan });
  await saveCost(file, cost);
  return { deltaYuan, measuredYuan: cost.measuredYuan };
}
