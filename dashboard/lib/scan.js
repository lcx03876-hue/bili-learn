// 只读扫描层：转写 / 笔记 / 帧目录 / 成本配置。
// 设计原则：任何一个目录缺失、文件损坏都只记录到 warnings/errors，不抛到上层。
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const BV_RE = /BV[0-9A-Za-z]{8,12}/;

/** 读文本文件，带大小上限与 BOM 容忍。 */
async function readText(file, maxBytes) {
  const st = await stat(file);
  if (st.size > maxBytes) {
    const buf = Buffer.alloc(maxBytes);
    const fh = await open(file, 'r');
    try {
      await fh.read(buf, 0, maxBytes, 0);
    } finally {
      await fh.close();
    }
    return { text: stripBom(buf.toString('utf8')), bytes: st.size, truncated: true };
  }
  const text = await readFile(file, 'utf8');
  return { text: stripBom(text), bytes: st.size, truncated: false };
}

function stripBom(t) {
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

function toIso(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 解析一份转写文件（导出给测试用）。 */
export function parseTranscript(text, file, mtimeMs) {
  const head = text.slice(0, 6000);
  const name = basename(file);
  const title = (head.match(/^#\s+(.+?)\s*$/m) || [])[1] || name.replace(/\.md$/i, '');
  const bvid =
    (head.match(/^-\s*bvid:\s*(BV[0-9A-Za-z]+)/m) || [])[1] ||
    (name.match(BV_RE) || [])[0] ||
    null;
  const durM = head.match(/^-\s*时长:\s*([\d.]+)\s*s/m);
  const covM = head.match(/^-\s*字幕覆盖:\s*([\d.]+)\s*%/m);
  const upM = head.match(/^-\s*UP:\s*(.+?)\s*$/m);
  const srcM = head.match(/^-\s*来源:\s*(\S+)/m);

  const bodyStart = text.indexOf('## 转写');
  const body = bodyStart >= 0 ? text.slice(bodyStart) : text;
  const rows = body.split('\n').filter((l) => /^\[\d{2}:\d{2}:\d{2}\]/.test(l));
  const chars = rows.reduce((n, l) => n + l.replace(/^\[\d{2}:\d{2}:\d{2}\]\s?/, '').trim().length, 0);
  const hasWarn = /⚠️|⚠/.test(head);

  return {
    id: bvid || name.replace(/\.md$/i, ''),
    bvid,
    file,
    name,
    title: title.slice(0, 200),
    up: upM ? upM[1] : null,
    source: srcM ? srcM[1] : null,
    durationSec: durM ? Number(durM[1]) : null,
    coverage: covM ? Number(covM[1]) : null,
    warning: hasWarn,
    lines: rows.length,
    chars,
    mtime: mtimeMs,
    modifiedAt: toIso(mtimeMs),
  };
}

/** 扫描转写目录。 */
export async function listTranscripts(dir, cfg) {
  const out = { dir, exists: false, items: [], errors: [] };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') out.errors.push({ file: dir, message: e.message });
    return out;
  }
  out.exists = true;

  for (const ent of entries) {
    if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
    const file = join(dir, ent.name);
    try {
      const st = await stat(file);
      const { text } = await readText(file, cfg.maxFileBytes);
      const t = parseTranscript(text, file, st.mtimeMs);
      t.low = t.coverage != null && t.coverage < cfg.lowCoverageThreshold * 100;
      t.low = t.low || t.warning;
      out.items.push(t);
    } catch (e) {
      out.errors.push({ file, message: e.message });
    }
  }
  out.items.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function shouldIgnoreDir(absPath, name, cfg) {
  if (cfg.ignoreDirs.includes(name)) return true;
  const rel = relative(resolve(cfg.__root || '.'), absPath).replace(/\\/g, '/');
  return cfg.ignoreDirs.some((ig) => rel === ig || rel.startsWith(ig.replace(/\\/g, '/') + '/'));
}

/** 递归扫描笔记目录（.md），跳过隐藏目录、node_modules、data/profile 等。 */
export async function listNotes(dirs, cfg) {
  const out = { dirs, items: [], errors: [], scanned: [] };
  for (const dir of dirs) {
    const one = await walkNotes(dir, cfg, 0);
    out.items.push(...one.items);
    out.errors.push(...one.errors);
    out.scanned.push({ dir, exists: one.exists, count: one.items.length });
  }
  // 同文件被多个目录覆盖时去重
  const seen = new Set();
  out.items = out.items.filter((n) => {
    const key = n.file.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  out.items.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function walkNotes(dir, cfg, depth) {
  const res = { exists: false, items: [], errors: [] };
  if (depth > cfg.maxNoteDepth) return res;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') res.errors.push({ file: dir, message: e.message });
    return res;
  }
  res.exists = true;

  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (ent.name.startsWith('.') || shouldIgnoreDir(full, ent.name, cfg)) continue;
      const sub = await walkNotes(full, cfg, depth + 1);
      res.items.push(...sub.items);
      res.errors.push(...sub.errors);
      continue;
    }
    if (!ent.isFile() || !/\.md$/i.test(ent.name)) continue;
    if (/^readme\.md$/i.test(ent.name)) continue; // README 是文档，不算笔记
    try {
      const st = await stat(full);
      const { text } = await readText(full, cfg.maxFileBytes);
      // 转写样本也放在 examples/ 里：用「## 转写」段区分，别把转写当笔记
      if (/^##\s*转写\s*$/m.test(text)) continue;
      res.items.push(parseNote(text, full, st.mtimeMs, cfg));
    } catch (e) {
      res.errors.push({ file: full, message: e.message });
    }
  }
  return res;
}

export function parseNote(text, file, mtimeMs, cfg) {
  const head = text.slice(0, 4000);
  const title = (head.match(/^#\s+(.+?)\s*$/m) || [])[1] || basename(file, extname(file));
  const bvid = (head.match(BV_RE) || [])[0] || null;
  const tsM = text.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
  const tags = new Set();
  if (cfg.tagRegex) {
    cfg.tagRegex.lastIndex = 0;
    for (const m of text.matchAll(cfg.tagRegex)) {
      const t = m[0].replace(/[，。、；：!?！？]+$/, '');
      if (t.length > 1) tags.add(t);
    }
  }
  return {
    file,
    name: basename(file),
    title: title.replace(/\s+/g, ' ').trim().slice(0, 200),
    bvid,
    tags: [...tags].slice(0, 50),
    firstTimestamp: tsM ? `${tsM[1]}:${tsM[2]}:${tsM[3]}` : null,
    firstTimestampSec: tsM ? Number(tsM[1]) * 3600 + Number(tsM[2]) * 60 + Number(tsM[3]) : null,
    chars: text.length,
    mtime: mtimeMs,
    modifiedAt: toIso(mtimeMs),
  };
}

/** 扫描帧目录：data/frames/<分组>/*.jpg */
export async function listFrames(dir, cfg) {
  const out = { dir, exists: false, groups: [], total: 0, totalBytes: 0, errors: [] };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') out.errors.push({ file: dir, message: e.message });
    return out;
  }
  out.exists = true;

  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const gdir = join(dir, ent.name);
    try {
      const files = await readdir(gdir, { withFileTypes: true });
      let count = 0;
      let bytes = 0;
      let latest = 0;
      for (const f of files) {
        if (!f.isFile() || !IMAGE_EXT.has(extname(f.name).toLowerCase())) continue;
        const st = await stat(join(gdir, f.name));
        count++;
        bytes += st.size;
        if (st.mtimeMs > latest) latest = st.mtimeMs;
      }
      if (count === 0) continue;
      const bvid = (ent.name.match(BV_RE) || [])[0] || null;
      out.groups.push({
        name: ent.name,
        bvid,
        frames: count,
        bytes,
        mtime: latest || null,
        modifiedAt: latest ? toIso(latest) : null,
      });
      out.total += count;
      out.totalBytes += bytes;
    } catch (e) {
      out.errors.push({ file: gdir, message: e.message });
    }
  }
  out.groups.sort((a, b) => b.frames - a.frames);
  return out;
}

/** 读单价配置（可选）与手工成本记录（可选）。绝不猜单价。 */
export async function readCosts(paths, cfg) {
  const res = {
    configFile: paths.costsFile,
    configExists: false,
    manualFile: paths.manualCostsFile,
    manualExists: false,
    yuanPerFrame: null,
    yuanPer1kTokens: null,
    tokensPerFrame: null,
    perFrameYuan: null,
    currency: 'CNY',
    manual: [],
    manualTotalYuan: null,
    warnings: [],
  };

  const costs = await readJsonSafe(paths.costsFile, res.warnings);
  if (costs.ok) {
    res.configExists = true;
    const c = costs.value || {};
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
    res.yuanPerFrame = num(c.yuanPerFrame);
    res.yuanPer1kTokens = num(c.yuanPer1kTokens);
    res.tokensPerFrame = num(c.tokensPerFrame);
    if (res.yuanPerFrame != null) res.perFrameYuan = res.yuanPerFrame;
    else if (res.yuanPer1kTokens != null && res.tokensPerFrame != null) {
      res.perFrameYuan = (res.yuanPer1kTokens * res.tokensPerFrame) / 1000;
    }
    if (c.currency) res.currency = String(c.currency).slice(0, 8);
    if (res.perFrameYuan == null) {
      res.warnings.push('costs.json 已配置，但没有可用的单价（yuanPerFrame，或 yuanPer1kTokens + tokensPerFrame 同时给）');
    }
  }

  const manual = await readJsonSafe(paths.manualCostsFile, res.warnings);
  if (manual.ok) {
    res.manualExists = true;
    const rows = normalizeManual(manual.value, res.warnings);
    res.manual = rows;
    res.manualTotalYuan = rows.reduce((n, r) => n + r.yuan, 0);
    if (rows.length === 0) res.warnings.push('manual-costs.json 里没有可解析的记录');
  }

  return res;
}

async function readJsonSafe(file, warnings) {
  try {
    const { text } = await readText(file, 1024 * 1024);
    const v = JSON.parse(text);
    return { ok: true, value: v };
  } catch (e) {
    if (e.code !== 'ENOENT') warnings.push(`读取 ${basename(file)} 失败：${e.message}`);
    return { ok: false, value: null };
  }
}

function normalizeManual(v, warnings) {
  const rows = [];
  const push = (date, yuan, note) => {
    const d = String(date || '').slice(0, 10);
    const y = Number(yuan);
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(d) || !Number.isFinite(y)) {
      warnings.push(`手工成本记录格式不对，已跳过：${JSON.stringify({ date, yuan })}`);
      return;
    }
    rows.push({ date: d, month: d.slice(0, 7), yuan: y, note: note ? String(note).slice(0, 120) : '' });
  };
  if (Array.isArray(v)) {
    for (const it of v) {
      if (it && typeof it === 'object') push(it.date || it.month || it.day, it.yuan ?? it.cost ?? it.amount, it.note);
    }
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'number') push(k, val, '');
      else if (val && typeof val === 'object') push(val.date || k, val.yuan ?? val.cost ?? val.amount, val.note);
    }
  } else if (v != null) {
    warnings.push('manual-costs.json 顶层应为数组或对象');
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export { IMAGE_EXT, BV_RE };
