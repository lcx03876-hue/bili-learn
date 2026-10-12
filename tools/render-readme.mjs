// 生成 README 里的两张配图（docs/images/*.png）。
//
//   node tools/render-readme.mjs
//
// 机制：把**真实文本**套进 HTML 模板 → 用 CDP 打开 file:// → 截图 → 写进 docs/images/。
// 零依赖：用的是内置 src/cdp.mjs（Node >= 22）+ 机器上已有的 Chrome/Edge。
//
// 数据来源（都不需要联网，也不需要登录）：
//   ① 终端图：优先**真的调用** `bin/bili-learn.mjs frames --pick`（用 data/frames 里最新的目录），
//      所以图里是货真价实的输出；本地没有抓帧时回退到 SAMPLE_TERMINAL（下方内嵌样例）。
//   ② 笔记图：读 examples/note-sample.md 的前 NOTE_LINES 行。
//
// 改完 CLI 的输出文案后重跑一次，图就跟着更新了。
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { attach } from '../src/bili.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IMG = join(ROOT, 'docs', 'images');
const TMP = join(ROOT, 'data', 'render');
const FRAMES = join(ROOT, 'data', 'frames');
const PORT = 9455;                 // 独立端口，别打扰用户自己的 9333 实例
const SHOT_PROFILE = join(ROOT, 'data', 'profile-render');
const NOTE_LINES = 15;

/** 本地没有抓帧时用的内嵌样例（真实输出，仅把本机路径换成了相对路径）。 */
const SAMPLE_TERMINAL = `=== demo-lecture（共 12 张，想读 6）===
  data\\frames\\demo-lecture\\000001.jpg   @0001  在场 18s
  data\\frames\\demo-lecture\\000019.jpg   @0019  在场 18s
  data\\frames\\demo-lecture\\000037.jpg   @0037  在场 19s
  data\\frames\\demo-lecture\\000056.jpg   @0056  在场 18s
  data\\frames\\demo-lecture\\000114.jpg   @0114  在场 18s
  data\\frames\\demo-lecture\\000132.jpg   @0132  在场 18s
  读这 6 张 ≈ ¥0.0078｜今日余量 ¥1.0000 → 读后剩 ¥0.9922`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** 抹掉本机绝对路径（含 Windows 用户名），图里只留相对路径。 */
const scrub = (s) => s.replaceAll(ROOT + '\\', '').replaceAll(ROOT + '/', '').replaceAll(ROOT.replace(/\\/g, '/') + '/', '');

const HTML_TERM = (body) => `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#ffffff;padding:28px;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
  .win{width:1040px;background:#0d1117;border:1px solid #30363d;border-radius:12px;overflow:hidden;
       box-shadow:0 8px 28px rgba(0,0,0,.28)}
  .bar{display:flex;align-items:center;gap:8px;padding:11px 14px;background:#161b22;border-bottom:1px solid #30363d}
  .dot{width:11px;height:11px;border-radius:50%}
  .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title{margin-left:10px;color:#8b949e;font:13px/1.4 Consolas,"Cascadia Mono",monospace}
  pre{padding:18px 20px;color:#c9d1d9;font:13.5px/1.75 Consolas,"Cascadia Mono",Menlo,monospace;white-space:pre}
  .hdr{color:#e6edf3;font-weight:700}
  .path{color:#79c0ff}
  .stamp{color:#7ee787}
  .held{color:#8b949e}
  .note{color:#d29922}
  .sum{background:#132a1c;border-left:3px solid #2ea043;display:block;padding:2px 0 2px 10px;margin-left:-10px;color:#7ee787}
  .cost{color:#ffa657}
</style><div class="win"><div class="bar">
  <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
  <span class="title">bili-learn frames --pick --want 6</span></div><pre>${body}</pre></div>`;

const HTML_NOTE = (body) => `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#ffffff;padding:28px;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
  .card{width:1000px;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:26px 30px;
        box-shadow:0 6px 22px rgba(0,0,0,.10)}
  h1{font-size:20px;line-height:1.5;color:#1f2328;margin-bottom:10px}
  .meta{font-size:12.5px;color:#59636e;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #eaeef2}
  h2{font-size:14px;color:#0969da;margin:18px 0 8px;letter-spacing:.3px}
  .row{font-size:13.5px;line-height:1.85;color:#1f2328;display:flex;gap:9px;margin:3px 0}
  .t{flex:0 0 auto;color:#0a3069;background:#ddf4ff;border-radius:5px;padding:0 6px;font:12px/1.7 Consolas,monospace}
  b{color:#1f2328}
  .arrow{color:#8250df}
  .concl{background:#f6f8fa;border-left:3px solid #0969da;padding:9px 12px;border-radius:0 6px 6px 0;font-size:13.5px;line-height:1.75}
  .ok{color:#1a7f37;font-weight:600}
  .pp{background:#fff8c5;border-radius:4px;padding:0 3px}
</style><div class="card">${body}</div>`;

function termBody(raw) {
  return raw.split('\n').map((line) => {
    const s = esc(line);
    if (/^===/.test(line)) return `<span class="hdr">${s}</span>`;
    if (/^  读这/.test(line)) return `<span class="sum"><span class="cost">${s}</span></span>`;
    if (/^  \S/.test(line)) {
      return s
        .replace(/^(\s*)(\S+?\.jpg)/, (m, sp, p) => `${sp}<span class="path">${p}</span>`)
        .replace(/(@\d{4,6})/, '<span class="stamp">$1</span>')
        .replace(/(在场 \d+s)/, '<span class="held">$1</span>');
    }
    if (/^（/.test(line)) return `<span class="note">${s}</span>`;
    return s;
  }).join('\n');
}

function noteBody(md) {
  const out = [];
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('# ')) { out.push(`<h1>${esc(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { out.push(`<h2>${esc(line.slice(3)).toUpperCase()}</h2>`); continue; }
    if (line.startsWith('- bvid')) { out.push(`<div class="meta">${esc(line.slice(2))}</div>`); continue; }
    if (line.startsWith('- 一句话结论')) {
      out.push(`<div class="concl"><b>一句话结论　</b>${esc(line.replace('- 一句话结论：', ''))}</div>`);
      continue;
    }
    if (line.startsWith('- ')) {
      let t = esc(line.slice(2));
      const m = t.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*/);
      const chip = m ? `<span class="t">${m[1]}</span>` : '';
      if (m) t = t.slice(m[0].length);
      t = t.replace(/→\s*落点：无（仅存档）/g, '<span class="arrow">→ 落点：仅存档</span>')
           .replace(/→\s*我用在：/g, '<span class="arrow">→ 我用在：</span>')
           .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
           .replace(/占用率 >50% 性能开始退化/g, '<span class="pp">占用率 &gt;50% 性能开始退化</span>');
      out.push(`<div class="row">${chip}<span>${t}</span></div>`);
      continue;
    }
    out.push(`<div class="row"><span>${esc(line)}</span></div>`);
  }
  return out.join('');
}

/** 真跑 CLI 拿输出；失败（没抓帧/环境问题）就用内嵌样例。 */
function terminalText() {
  try {
    // 选"最近抓的目录"——规则与 CLI 的默认一致（按 mtime，而不是目录名字母序）
    let newest = null;
    for (const d of readdirSync(FRAMES, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const m = statSync(join(FRAMES, d.name)).mtimeMs;
      if (!newest || m > newest.mtimeMs) newest = { name: d.name, mtimeMs: m };
    }
    if (!newest) return { text: SAMPLE_TERMINAL, source: '内嵌样例（本地没有 data/frames）' };
    const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'bili-learn.mjs'), 'frames', '--pick', '--dir', newest.name, '--want', '6'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { text: out.trimEnd(), source: `真实 CLI 输出（frames 目录 ${newest.name}）` };
  } catch (e) {
    return { text: SAMPLE_TERMINAL, source: `内嵌样例（调用 CLI 失败：${e.message.split('\n')[0]}）` };
  }
}

const { cdp } = await attach({ port: PORT, profileDir: SHOT_PROFILE, headless: true });
await mkdir(IMG, { recursive: true });
await mkdir(TMP, { recursive: true });

async function shoot(name, html, width) {
  const file = join(TMP, `${name}.html`);
  await writeFile(file, html, 'utf8');
  // 先用很矮的视口量内容真实高度（用高视口量会得到视口值本身，图底一大片空白）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 120, deviceScaleFactor: 2, mobile: false });
  await cdp.navigate(`file:///${file.replace(/\\/g, '/')}`);
  await cdp.evaluate('document.fonts.ready.then(() => 1)').catch(() => 0);
  await new Promise((r) => setTimeout(r, 300));
  const h = Math.ceil(await cdp.evaluate('document.body.scrollHeight'));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 2, mobile: false });
  await new Promise((r) => setTimeout(r, 250));
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    // 注意：clip.scale 会与 deviceScaleFactor **叠乘**（都写 2 就是 4x，图体积翻几倍）
    clip: { x: 0, y: 0, width, height: h, scale: 1 },
  });
  await writeFile(join(IMG, `${name}.png`), Buffer.from(data, 'base64'));
  const kb = (await stat(join(IMG, `${name}.png`))).size / 1024;
  console.log(`docs/images/${name}.png  ${width}×${h} (2x)  ${kb.toFixed(0)}KB`);
}

const term = terminalText();
console.log(`终端图数据来源：${term.source}`);
await shoot('frames-pick', HTML_TERM(termBody(scrub(term.text))), 1040 + 56);

const notePath = join(ROOT, 'examples', 'note-sample.md');
if (!existsSync(notePath)) { console.log(`缺少 ${notePath}，跳过笔记图`); } else {
  const noteMd = (await readFile(notePath, 'utf8')).split('\n').slice(0, NOTE_LINES).join('\n');
  await shoot('note-structure', HTML_NOTE(noteBody(noteMd)), 1000 + 60);
}

await cdp.send('Browser.close').catch(() => {});
console.log('完成。两张图已写入 docs/images/（headless Chrome 已关闭）');
process.exit(0);
