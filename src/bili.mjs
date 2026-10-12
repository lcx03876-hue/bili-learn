// Bilibili domain layer: everything runs inside the controlled browser page,
// so API calls carry the logged-in session (no wbi signing, no anti-bot 412).
import { ensureBrowser, findOrOpenPage, newPage, Cdp, DEFAULT_PORT } from './cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

export { DEFAULT_PORT };

const PRELUDE = `const __f = async (u) => { const r = await fetch(u, { credentials: 'include' }); const t = await r.text(); try { return JSON.parse(t); } catch { return { code: -999, raw: t.slice(0, 200) }; } };`;

/** Launch/reuse the browser and attach a CDP session to a page. */
export async function attach({ port = DEFAULT_PORT, profileDir, headless = false, reusePage = null, url = 'about:blank' } = {}) {
  const b = await ensureBrowser({ port, profileDir, headless });
  const target = reusePage ? await findOrOpenPage(port, reusePage) : await newPage(port, url);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable').catch(() => {});
  return { cdp, target, port, reusedBrowser: b.reused };
}

export async function loginState(cdp) {
  return cdp.evaluate(`(async () => { ${PRELUDE}
    const nav = await __f('https://api.bilibili.com/x/web-interface/nav');
    return { isLogin: !!nav?.data?.isLogin, uname: nav?.data?.uname ?? null, mid: nav?.data?.mid ?? null, code: nav.code };
  })()`);
}

export function parseDuration(text) {
  const parts = String(text ?? '').trim().split(':').map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Scrape the public search page (works with the browser session, no wbi). */
export async function searchVideos(cdp, keyword, { limit = 12 } = {}) {
  await cdp.navigate(`https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`);
  await sleep(2500);
  const items = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.bili-video-card')];
    return cards.map((c) => {
      const a = c.querySelector('a[href*="/video/"]');
      const href = a?.href ?? '';
      const bvid = (href.match(/\\/video\\/(BV[0-9A-Za-z]+)/) ?? [])[1] ?? null;
      const title = (c.querySelector('.bili-video-card__info--tit')?.getAttribute('title') || c.querySelector('.bili-video-card__info--tit')?.textContent || '').trim();
      const up = (c.querySelector('.bili-video-card__info--author')?.textContent || c.querySelector('[class*=author]')?.textContent || '').trim();
      const durText = (c.querySelector('.bili-video-card__stats__duration')?.textContent || '').trim();
      const play = (c.querySelector('.bili-video-card__stats--item')?.textContent || '').trim();
      return { bvid, title, up, durText, play, href };
    }).filter((x) => x.bvid);
  })()`);
  return items.slice(0, limit).map((x) => ({ ...x, durSec: parseDuration(x.durText) }));
}

/** Video metadata + subtitle track list, fetched from inside the page. */
export async function videoInfo(cdp, bvid, { p = 1 } = {}) {
  return cdp.evaluate(`(async () => { ${PRELUDE}
    const view = await __f('https://api.bilibili.com/x/web-interface/view?bvid=${bvid}');
    if (view.code !== 0) return { bvid: '${bvid}', ok: false, code: view.code, message: view.message };
    const pages = view.data.pages ?? [];
    const page = pages[${p - 1}] ?? pages[0] ?? { cid: view.data.cid, part: view.data.title };
    const player = await __f('https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=' + page.cid);
    const subs = (player.data?.subtitle?.subtitles ?? []).map((s) => ({
      lan: s.lan_doc, ai: s.type === 1 || /ai/i.test(s.lan ?? ''),
      url: s.subtitle_url?.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url,
    }));
    return { bvid: '${bvid}', ok: true, aid: view.data.aid, cid: page.cid, p: ${p}, pageCount: pages.length,
      part: page.part, title: view.data.title, desc: view.data.desc ?? '', duration: page.duration ?? view.data.duration,
      up: view.data.owner?.name ?? '', owner: view.data.owner?.mid ?? null, subs, subCount: subs.length,
      playerMessage: player.message };
  })()`);
}

/** Full transcript text for one video part, with timestamps. */
export async function fetchTranscript(cdp, bvid, { p = 1, preferAi = true } = {}) {
  const info = await videoInfo(cdp, bvid, { p });
  if (!info.ok) return { ...info, lines: [], text: '' };
  if (!info.subs.length) return { ...info, lines: [], text: '', note: 'no subtitle track' };

  const picked = preferAi ? (info.subs.find((s) => s.ai) ?? info.subs[0]) : info.subs[0];
  const body = await cdp.evaluate(`(async () => {
    const r = await fetch(${JSON.stringify(picked.url)}, { credentials: 'omit' });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    return { lines: (j.body ?? []).map((x) => ({ from: x.from, to: x.to, content: x.content })) };
  })()`);
  if (body.error) return { ...info, lines: [], text: '', note: body.error, picked: picked.lan };

  const lines = body.lines ?? [];
  const text = lines.map((l) => l.content).join('\n');
  // 字幕轨经常只覆盖前几分钟：算覆盖率，避免把"半个视频"当成学完了。
  const lastTo = lines.length ? Number(lines[lines.length - 1].to) || 0 : 0;
  const duration = Number(info.duration) || 0;
  const coverage = duration > 0 ? Math.min(1, lastTo / duration) : (lines.length ? 1 : 0);
  return { ...info, lines, text, picked: picked.lan, lineCount: lines.length, lastTo, coverage };
}

export function transcriptToMarkdown(info, lines) {
  const head = [
    `# ${info.title}`,
    '',
    `- bvid: ${info.bvid}${info.pageCount > 1 ? ` (P${info.p}/${info.pageCount} ${info.part})` : ''}`,
    `- UP: ${info.up}`,
    `- 时长: ${info.duration}s  |  字幕: ${info.picked ?? 'n/a'}  |  行数: ${lines.length}`,
    info.coverage != null ? `- 字幕覆盖: ${Math.round(info.coverage * 100)}%${info.coverage < 0.8 ? '  ⚠️ 字幕轨未覆盖全片，转写不完整' : ''}` : null,
    `- 来源: https://www.bilibili.com/video/${info.bvid}/`,
    info.desc ? `- 简介: ${info.desc.replace(/\s+/g, ' ').slice(0, 300)}` : null,
    '',
    '## 转写',
    '',
  ].filter(Boolean);
  const body = lines.map((l) => `[${fmt(l.from)}] ${l.content}`);
  return `${head.join('\n')}\n${body.join('\n')}\n`;
}

function fmt(sec) {
  const s = Math.floor(Number(sec) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

const READ_STATE = `(() => {
  const v = document.querySelector('video');
  if (!v) return { missing: true };
  return { t: v.currentTime, dur: v.duration, paused: v.paused, ended: v.ended, muted: v.muted,
    rate: v.playbackRate, rs: v.readyState, err: v.error?.message ?? null,
    quality: (document.querySelector('.bpx-player-ctrl-quality-result')?.textContent || '').trim(),
    title: document.title };
})()`;

async function clickPlay(cdp) {
  const box = await cdp.evaluate(`(() => { const b = document.querySelector('.bpx-player-ctrl-play') || document.querySelector('.bpx-player-video-wrap'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!box) return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

/**
 * Really play one video part in the controlled browser and wait for it to finish.
 * Returns { status: 'completed' | 'stopped' | 'stalled' | 'unavailable' | 'error', watched, ... }
 */
export async function playVideo(cdp, bvid, {
  p = 1, rate = 1, mute = true, pollMs = 3000, onTick, shouldStop, maxStallRetries = 8, maxWallMinutes = 240,
  readyTimeoutMs = 45000, allowVip = false, restartFromZero = false,
  now = () => Date.now(),   // 可注入时钟：测试卡顿恢复的节流逻辑时不必真等 4 秒
} = {}) {
  await cdp.navigate(`https://www.bilibili.com/video/${bvid}/?p=${p}&autoplay=1`);

  // 番剧/独家稿件会 302 到 /bangumi/play/：没有大会员时播放器永远 readyState=0，快速失败不空等。
  const href = await cdp.evaluate('location.href').catch(() => '');
  if (!allowVip && href.includes('/bangumi/')) {
    return { status: 'vip-bangumi', reason: 'redirected to bangumi (VIP/独家)', href };
  }

  let state;
  try {
    state = await cdp.waitFor(`(() => { const v = document.querySelector('video'); return v && v.duration > 0 ? { dur: v.duration } : null; })()`, { timeoutMs: allowVip ? Math.max(readyTimeoutMs, 90000) : readyTimeoutMs, label: 'video ready' });
  } catch (e) {
    const pageText = await cdp.evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(0, 300)`).catch(() => '');
    const where = await cdp.evaluate('location.href').catch(() => '');
    return { status: 'unavailable', reason: e.message, pageText, href: where };
  }

  const dur = state.dur;
  // B 站会记住上次播放位置：`autoplay=1` 导航后可能从上次进度**续播**。
  // 实测踩到：以为在抓整条，其实从 23:48 开始，27 秒就"播完"了。抓帧/整讲分析时必须回到 0。
  let restartedFrom = null;
  if (restartFromZero) {
    const before = await cdp.evaluate(`(() => { const v = document.querySelector('video'); return v ? v.currentTime : null; })()`).catch(() => null);
    if (before != null && before > 2) {
      restartedFrom = Math.floor(before);
      await cdp.evaluate(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = 0; return 1; })()`).catch(() => {});
      await sleep(1500);   // 等 seek 生效，别让抓帧拿到旧画面
    }
  }
  await cdp.evaluate(`(() => { const v = document.querySelector('video'); v.muted = ${mute ? 'true' : 'false'}; v.playbackRate = ${rate}; v.play().catch(() => {}); return 1; })()`);

  const deadline = Date.now() + Math.min(maxWallMinutes * 60000, (dur / Math.max(0.25, rate)) * 1000 * 2 + 120000);
  let stalls = 0;
  let lastT = 0;
  let watched = 0;
  let recoveries = 0;      // 成功执行的恢复动作次数（用于升级恢复强度）
  let lastRecoveryAt = 0;
  const MAX_RECOVERIES = 12;

  /**
   * 卡顿恢复阶梯（对"播放器卡住"和"网络断了"都试一遍）：
   *   1) 往回退 3 秒再 play —— 最常见有效：卡在缓冲边界上，回退能换到新的缓冲段
   *   2) 再不行就整页 reload 并按 currentTime 跳回原位（同时刷新 CDN 连接，治网络侧卡住）
   *   3) 最后换清晰度（B 站 mplayer 的清晰度菜单），绕开卡住的那条流
   * 每次恢复之间有 4 秒间隔，避免疯狂重试被风控。
   */
  async function recover(reason) {
    const nowMs = now();
    if (nowMs - lastRecoveryAt < 4000) return false;
    if (recoveries >= MAX_RECOVERIES) return false;
    lastRecoveryAt = nowMs;
    recoveries += 1;

    const where = await cdp.evaluate(`(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused, readyState: v.readyState } : null; })()`).catch(() => null);
    if (!where) return false;

    if (recoveries <= 4) {
      await cdp.evaluate(`(() => { const v = document.querySelector('video'); if (v) { v.currentTime = Math.max(0, v.currentTime - 3); v.play().catch(() => {}); } return 1; })()`).catch(() => {});
      return true;
    }
    if (recoveries <= 8) {
      const href = await cdp.evaluate('location.href').catch(() => '');
      const at = where.t;
      await cdp.navigate(href, { waitForLoad: false }).catch(() => {});
      await sleep(2500);
      await cdp.evaluate(`(() => { const v = document.querySelector('video'); if (v) { v.currentTime = ${Math.max(0, at - 2)}; v.play().catch(() => {}); } return 1; })()`).catch(() => {});
      return true;
    }
    // 换清晰度（需登录）；点不到就当失败，交给上层的换标签页
    const ok = await cdp.evaluate(`(() => {
      const q = document.querySelector('.bpx-player-ctrl-quality');
      if (!q) return false;
      q.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      q.click();
      const items = [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')];
      if (!items.length) return false;
      const cur = items.findIndex((i) => i.className.includes('active'));
      const next = items[cur >= 0 ? (cur + 1) % items.length : 0];
      next.click();
      return true;
    })()`).catch(() => false);
    return !!ok;
  }

  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (shouldStop?.()) {
      await cdp.evaluate(`(() => { const v = document.querySelector('video'); if (v) v.pause(); return 1; })()`).catch(() => {});
      return { status: 'stopped', watched, dur };
    }
    let s;
    try {
      s = await cdp.evaluate(READ_STATE);
    } catch {
      continue;
    }
    if (s.missing) return { status: 'unavailable', reason: 'video element disappeared', watched, dur };
    watched = Math.max(watched, Math.floor(s.t));
    if (s.err) return { status: 'error', reason: s.err, watched, dur };
    onTick?.({ ...s, bvid, p, dur });

    if (s.ended || s.t >= dur - 1.5) return { status: 'completed', watched: Math.floor(dur), dur, quality: s.quality, restartedFrom, recoveries };

    if (s.t > lastT + 0.5) {
      // 进度在涨 → 已自愈，计数清零（不能把"网络缓一下就续上"当成硬卡顿）
      if (stalls > 0 || recoveries > 0) {
        stalls = 0;
        recoveries = 0;
      }
      lastT = s.t;
    } else {
      // 进度没动：先尝试"播放器卡住"的常规手段
      stalls += 1;
      if (stalls >= 2) await cdp.evaluate(`(() => { const v = document.querySelector('video'); v?.play().catch(() => {}); return 1; })()`).catch(() => {});
      if (stalls >= 3) await clickPlay(cdp).catch(() => {});
      // 再不行就走恢复阶梯（seek 回退 → 重载 → 换清晰度），治播放器与网络两侧
      if (stalls >= 4) {
        const did = await recover('stalled');
        onTick?.({ ...s, bvid, p, dur, recovering: did ? recoveries : undefined });
        if (!did && recoveries >= MAX_RECOVERIES) {
          return { status: 'stalled', watched: Math.floor(s.t), dur, quality: s.quality, recoveries };
        }
      }
    }
  }
  return { status: 'timeout', watched, dur, restartedFrom, recoveries };
}

/** Screenshot the login QR code so the caller can show it to the user. */
export async function captureLoginQr(cdp, outFile) {
  await cdp.navigate('https://passport.bilibili.com/login');
  // 新 profile 首次加载较慢，轮询到二维码真正渲染出尺寸为止。
  const findQr = `(() => {
    const sels = ['.login-scan-box', '.login-scan', '.qrcode-img', '.login-qrcode', 'img[alt*="二维码"]', 'canvas'];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 60 && r.height > 60) {
          return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height), scale: 2, sel };
        }
      }
    }
    return null;
  })()`;
  let clip = null;
  for (let i = 0; i < 30; i++) {
    clip = await cdp.evaluate(findQr).catch(() => null);
    if (clip) break;
    await sleep(1000);
  }
  const shot = await cdp.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, Buffer.from(shot.data, 'base64'));
  return { file: outFile, clipped: !!clip, selector: clip?.sel ?? null };
}

export async function waitForLogin(cdp, { timeoutMs = 300000, intervalMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await loginState(cdp).catch((e) => ({ isLogin: false, error: e.message }));
    if (last.isLogin) return { ok: true, ...last };
    await sleep(intervalMs);
  }
  return { ok: false, ...last };
}
