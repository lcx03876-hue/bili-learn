// 抓帧：把视频画面按"变化检测"抽成 JPEG，供 agent 事后用 read_image 看板书。
//
// 零依赖：画面采样借用页面内同源 canvas（video 与页面同为 bilibili.com，画布不会被跨域污染），
// 存盘用 CDP 的 Page.captureScreenshot（避开 o 域跨域限制）。
//
// 两级采样：
//   1) 每 sampleMs 采一张 32x18 灰度缩略图 → 64 位均值哈希
//   2) 与上一张的汉明距离 > changeThreshold 才存全分辨率图（并受 minGapMs 与 maxFrames 约束）
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 灰度数组 → 64 位均值哈希（用 Number 装，安全整数 53 位够用）。 */
export function averageHash(gray) {
  if (!gray?.length) return 0;
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const avg = sum / gray.length;
  let hash = 0;
  for (let i = 0; i < gray.length && i < 53; i++) if (gray[i] > avg) hash += 2 ** i;
  return hash;
}

/** 32 位整数的 popcount。 */
function popcount32(x) {
  let n = x >>> 0;
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return ((n * 0x01010101) >>> 24) & 0x3f;
}

const LOW_26 = 0x3ffffff; // 2^26 - 1

/**
 * 两个哈希的汉明距离：真正的按位异或后数 1 的个数。
 * 哈希最多 53 位，超过 32 位，所以拆成低 26 位 + 高 27 位两段各自异或，
 * 避免 JS 位运算的 32 位符号问题。
 */
export function hammingDistance(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return Infinity;
  const lo = (a % 2 ** 26) ^ (b % 2 ** 26);
  const hi = Math.floor(a / 2 ** 26) ^ Math.floor(b / 2 ** 26);
  return popcount32(lo & LOW_26) + popcount32(hi);
}

/**
 * 两帧灰度数组的平均绝对差（0-255 尺度）。
 * 为什么不用均值哈希：实测发现均值哈希对"整幅板书渐进变化"不敏感——
 * 采样三次返回同一个哈希，整段视频只会抓到开头一张。逐像素差才能看见这种变化。
 */
export function meanAbsDiff(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** 判断当前帧相对上一帧是否算"画面变了"（用逐像素平均绝对差，单位：灰度级）。 */
export function isSceneChanged(prevGray, curGray, { changeThreshold = 6 } = {}) {
  if (prevGray == null) return true;
  return meanAbsDiff(prevGray, curGray) > changeThreshold;
}

/** data:image/jpeg;base64,... → Buffer；不是 JPEG data URL 时返回 null。 */
export function jpegBufferFromDataUrl(dataUrl) {
  const m = /^data:image\/jpeg;base64,(.+)$/i.exec(String(dataUrl ?? ''));
  return m ? Buffer.from(m[1], 'base64') : null;
}

/**
 * 秒数 → 文件名用的时间标记。
 * 注意：超过 1 小时必须用 6 位 hhmmss，否则 `@0000`（结尾）会和 `@0000`（开头）**撞名覆盖**——
 * 这个坑在 P4（2922s）上真实踩到了。所以由调用方传入视频时长来决定位数。
 */
export function stampOf(seconds, totalSec = 0) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  // 只要知道总时长（≥1 分钟）就用固定 6 位 hhmmss。
  // 为什么放宽到 1 分钟：位数必须**全程一致**，否则同一目录里 4 位与 6 位混用会撞名
  // （真实踩到：视频放完后自动回放，第二遍的 @0000 与第一遍的某张撞上）。
  const needHours = h > 0 || Number(totalSec) >= 60;
  return needHours ? `${p(h)}${p(m)}${p(sec)}` : `${p(m)}${p(sec)}`;
}

/** 文件名用的 mmss / hhmmss 标记 → 秒（stampOf 的逆运算）。 */
export function stampToSeconds(stamp) {
  const s = String(stamp ?? '').replace(/\D/g, '');
  if (s.length === 4) return Number(s.slice(0, 2)) * 60 + Number(s.slice(2));
  if (s.length === 6) return Number(s.slice(0, 2)) * 3600 + Number(s.slice(2, 4)) * 60 + Number(s.slice(4));
  return NaN;
}

/** 视频目录：data/frames/<bvid>-P<n>（单 P 视频用 <bvid>）。 */
export function framesDirFor(baseDir, bvid, p, pageCount = 1) {
  const name = pageCount > 1 ? `${bvid}-P${p}` : bvid;
  return join(baseDir, name);
}

/**
 * 挑"值得读"的关键帧。
 *
 * 判据不是均匀抽样，而是**在场时长**：一张图停留得越久，越可能是**完整板书/整页 PPT**
 * （过渡动画、鼠标移动那些中间帧在场时间极短，读它们纯属浪费 vision token）。
 * 先取在场最久的，再用"按顺序均匀取点"补齐覆盖，最后按时间戳排序返回。
 *
 * @param {{f:string,t:number,heldSec:number}[]} rows 按抓取顺序排列的帧
 * @param {number} want 想要几张
 */
export function pickKeyFrames(rows, want = 8) {
  const byHeld = [...rows].sort((a, b) => b.heldSec - a.heldSec);
  const step = Math.max(1, Math.floor(rows.length / Math.max(1, want)));
  const spread = rows.filter((_, i) => i % step === 0);
  const seen = new Set();
  const picks = [];
  for (const r of [...byHeld, ...spread]) {
    if (seen.has(r.f) || picks.length >= want + 2) continue;
    seen.add(r.f);
    picks.push(r);
  }
  picks.sort((a, b) => a.t - b.t);
  return picks;
}

/**
 * 从任意 B 站链接/短链/裸 bvid 里解析出 { bvid, p }。
 * 支持：BV 全链接、带 ?p=N、b23.tv 短链（短链需要先跟一次跳转，见 resolveShortLink）。
 * 解析不出 bvid 时返回 { bvid: null, p }。
 */
export function parseBiliUrl(input) {
  const raw = String(input ?? '').trim();
  const bv = /(BV[0-9A-Za-z]{8,12})/.exec(raw);
  const pMatch = /[?&]p=(\d+)/.exec(raw);
  const p = pMatch ? Math.max(1, Number(pMatch[1])) : 1;
  return { bvid: bv ? bv[1] : null, p };
}

/** 是否是 b23.tv 短链（需要先解析跳转才能拿到 bvid）。 */
export function isShortLink(input) {
  return /^https?:\/\/b23\.tv\//i.test(String(input ?? '').trim());
}

/** 页面内采样：返回小灰度数组（0-255），失败返回 null。 */
export function thumbnailExpression(w = 32, h = 18) {
  return `(() => {
    const v = document.querySelector('video');
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = ${w}; c.height = ${h};
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, ${w}, ${h});
    let d;
    try { d = g.getImageData(0, 0, ${w}, ${h}).data; } catch (e) { return { error: String(e && e.message || e) }; }
    const out = new Array(${w * h});
    for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    return out;
  })()`;
}

/** 页面内取全分辨率 JPEG data URL，失败返回 null。 */
export function frameDataUrlExpression(width = 1280, height = 720, quality = 0.85) {
  return `(() => {
    const v = document.querySelector('video');
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = ${width}; c.height = ${height};
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, ${width}, ${height});
    try { return c.toDataURL('image/jpeg', ${quality}); } catch (e) { return { error: String(e && e.message || e) }; }
  })()`;
}

/**
 * 造一个抓帧器：自带"上一帧哈希 / 上次存盘时间 / 已存张数"状态。
 * cdp 需提供 evaluate()；cdp.send 仅在没有 canvas 路可走时才用（此处不用）。
 */
export function createFrameGrabber(cdp, {
  dir, intervalMs = 2000, minGapMs = 8000, maxFrames = 40, changeThreshold = 2.5,
  width = 1280, height = 720, quality = 0.85, totalSec = 0, thumbWidth = 32, thumbHeight = 18, log = () => {},
} = {}) {
  const state = { prevGray: null, lastSavedAt: 0, lastSampleAt: 0, saved: 0, skippedReason: null, errors: 0, lastDiff: null, totalSec: Number(totalSec) || 0 };
  const saved = [];

  return {
    state,
    saved,
    /** 在播放的 tick 里调用；内部自己按 intervalMs 节流。 */
    async tick(t) {
      const now = Date.now();
      if (now - state.lastSampleAt < intervalMs) return null;
      state.lastSampleAt = now;
      if (state.saved >= maxFrames) { state.skippedReason = 'maxFrames'; return null; }

      let thumb;
      try {
        thumb = await cdp.evaluate(thumbnailExpression(thumbWidth, thumbHeight));
      } catch { state.errors += 1; return null; }
      if (!Array.isArray(thumb)) return null;

      const diff = state.prevGray == null ? Infinity : meanAbsDiff(state.prevGray, thumb);
      const changed = state.prevGray == null || diff > changeThreshold;
      state.prevGray = thumb;
      state.lastDiff = Number.isFinite(diff) ? diff : null;
      if (!changed) return null;
      if (now - state.lastSavedAt < minGapMs) return null;

      let dataUrl;
      try {
        dataUrl = await cdp.evaluate(frameDataUrlExpression(width, height, quality));
      } catch { state.errors += 1; return null; }
      const buf = jpegBufferFromDataUrl(dataUrl);
      if (!buf) return null;

      const stamp = stampOf(t, state.totalSec);
      // 撞名保护：同一秒（或时长未知导致位数退化）已有图时不覆盖，追加 -k
      let target = join(dir, `${stamp}.jpg`);
      for (let k = 1; existsSync(target); k++) target = join(dir, `${stamp}-${k}.jpg`);
      await mkdir(dir, { recursive: true });
      await writeFile(target, buf);
      state.lastSavedAt = now;
      state.saved += 1;
      const entry = { t: Math.floor(t), stamp, file: target, bytes: buf.length, at: new Date().toISOString() };
      saved.push(entry);
      log(`frame @${stamp} (${Math.round(buf.length / 1024)}KB) → ${target}`);
      return entry;
    },
  };
}
