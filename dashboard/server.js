#!/usr/bin/env node
// bili-learn 本地只读学习仪表盘
// 零依赖：只用 node:http / fs / path / url；只读仓库数据，唯一写操作是导出到 reports/。
import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { URL } from 'node:url';

import { loadConfig, PUBLIC_DIR, ROOT } from './lib/config.js';
import { safeRelative } from './lib/safe.js';
import { listTranscripts, listNotes, listFrames, readCosts } from './lib/scan.js';
import { buildStats } from './lib/stats.js';
import { writeReport, buildMarkdown } from './lib/report.js';
import { displayPath } from './lib/safe.js';

const { cfg, paths, warnings: cfgWarnings, hasConfig, configFile } = loadConfig();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const STARTED = Date.now();
const VERSION = '0.1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- 扫描 + 缓存
let cache = null;

async function scanAll(force = false) {
  if (!force && cache && Date.now() - cache.at < cfg.scanCacheMs) return cache;
  const scannedAt = new Date().toISOString();
  const transcripts = await listTranscripts(paths.transcriptsDir, cfg);
  const notes = await listNotes(paths.notesDirs, cfg);
  const frames = await listFrames(paths.framesDir, cfg);
  const costs = await readCosts(paths, cfg);

  const snapshot = buildStats({
    transcripts, notes, frames, costs, cfg, paths,
    repoRoot: ROOT, scannedAt,
  });
  snapshot.warnings = [...cfgWarnings, ...costs.warnings];

  cache = { at: Date.now(), snapshot, transcripts, notes, frames, costs };
  return cache;
}

// ---------------------------------------------------------------- HTTP helpers
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, status, code, message, extra) {
  sendJson(res, status, { ok: false, error: { code, message, ...(extra || {}) } });
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

async function serveStatic(req, res, pathname) {
  const rel = safeRelative(pathname);
  if (rel == null) return fail(res, 400, 'bad_path', '非法路径');
  const file = join(PUBLIC_DIR, rel);
  let st;
  try {
    st = await stat(file);
  } catch {
    return fail(res, 404, 'not_found', '资源不存在');
  }
  if (!st.isFile()) return fail(res, 404, 'not_found', '资源不存在');
  const buf = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// ---------------------------------------------------------------- API
function filterVideos(videos, notes, query) {
  const q = (query.get('q') || '').trim().toLowerCase();
  const sort = query.get('sort') || 'mtime';
  const order = query.get('order') === 'asc' ? 'asc' : 'desc';
  const noteByBvid = new Map();
  for (const n of notes) {
    if (!n.bvid) continue;
    noteByBvid.set(n.bvid, (noteByBvid.get(n.bvid) || 0) + 1);
  }

  let list = videos.map((v) => ({
    bvid: v.bvid,
    title: v.title,
    up: v.up,
    coverage: v.coverage,
    low: !!v.low,
    durationSec: v.durationSec,
    lines: v.lines,
    chars: v.chars,
    mtime: v.mtime,
    modifiedAt: v.modifiedAt,
    file: displayPath(ROOT, v.file),
    noteCount: v.bvid ? noteByBvid.get(v.bvid) || 0 : 0,
  }));

  if (q) {
    list = list.filter(
      (v) =>
        (v.bvid || '').toLowerCase().includes(q) ||
        (v.title || '').toLowerCase().includes(q) ||
        (v.up || '').toLowerCase().includes(q),
    );
  }

  const dir = order === 'asc' ? 1 : -1;
  const cmp = {
    mtime: (a, b) => (a.mtime - b.mtime) * dir,
    coverage: (a, b) => ((a.coverage ?? -1) - (b.coverage ?? -1)) * dir,
    title: (a, b) => a.title.localeCompare(b.title, 'zh') * dir,
    chars: (a, b) => (a.chars - b.chars) * dir,
    frames: () => 0,
  }[sort] || ((a, b) => (a.mtime - b.mtime) * dir);

  list.sort(cmp);
  return { total: videos.length, matched: list.length, items: list, sort, order, q };
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/health') {
    return ok(res, { status: 'ok', version: VERSION, uptimeSec: Math.round((Date.now() - STARTED) / 1000) });
  }

  if (pathname === '/api/meta') {
    return ok(res, {
      version: VERSION,
      root: ROOT,
      configFile: displayPath(ROOT, configFile),
      hasConfig,
      warnings: cfgWarnings,
      paths: {
        transcripts: displayPath(ROOT, paths.transcriptsDir),
        frames: displayPath(ROOT, paths.framesDir),
        notes: paths.notesDirs.map((d) => displayPath(ROOT, d)),
        reports: displayPath(ROOT, paths.reportsDir),
        costs: displayPath(ROOT, paths.costsFile),
        manualCosts: displayPath(ROOT, paths.manualCostsFile),
      },
      lowCoverageThreshold: cfg.lowCoverageThreshold,
      scanCacheMs: cfg.scanCacheMs,
    });
  }

  if (pathname === '/api/stats') {
    const c = await scanAll();
    return ok(res, c.snapshot);
  }

  if (pathname === '/api/videos') {
    const c = await scanAll();
    const data = filterVideos(c.transcripts.items, c.notes.items, url.searchParams);
    data.scannedAt = c.snapshot.scannedAt;
    return ok(res, data);
  }

  if (pathname === '/api/notes') {
    const c = await scanAll();
    const s = c.snapshot;
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    let items = c.notes.items.map((n) => ({
      title: n.title,
      bvid: n.bvid,
      tags: n.tags,
      firstTimestamp: n.firstTimestamp,
      firstTimestampSec: n.firstTimestampSec,
      chars: n.chars,
      modifiedAt: n.modifiedAt,
      file: displayPath(ROOT, n.file),
    }));
    if (q) {
      items = items.filter(
        (n) =>
          (n.title || '').toLowerCase().includes(q) ||
          (n.bvid || '').toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return ok(res, {
      total: c.notes.items.length,
      matched: items.length,
      items,
      todo: s.todo,
      todoCount: s.todoCount,
      withNote: s.withNote,
      tags: s.tags,
      weeks: s.weeks,
      months: s.months,
      scannedAt: s.scannedAt,
    });
  }

  if (pathname === '/api/costs') {
    const c = await scanAll();
    const s = c.snapshot;
    return ok(res, {
      frames: s.frames,
      costs: s.costs,
      scannedAt: s.scannedAt,
    });
  }

  if (pathname === '/api/reports') {
    const dir = paths.reportsDir;
    let items = [];
    let exists = true;
    try {
      const ents = await readdir(dir, { withFileTypes: true });
      for (const ent of ents) {
        if (!ent.isFile() || !/\.(md|html)$/i.test(ent.name)) continue;
        const st = await stat(join(dir, ent.name));
        items.push({ name: ent.name, size: st.size, mtime: st.mtimeMs, modifiedAt: new Date(st.mtimeMs).toISOString() });
      }
    } catch (e) {
      if (e.code === 'ENOENT') exists = false;
      else throw e;
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return ok(res, { dir: displayPath(ROOT, dir), exists, items });
  }

  if (pathname === '/api/export') {
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '导出只接受 POST');
    let payload = {};
    try {
      payload = await readJsonBody(req);
    } catch (e) {
      return fail(res, 400, 'bad_body', e.message);
    }
    const c = await scanAll(true);
    try {
      const written = await writeReport(c.snapshot, c.transcripts.items, c.notes.items, paths.reportsDir);
      return ok(res, {
        markdown: displayPath(ROOT, written.md),
        html: displayPath(ROOT, written.html),
        base: written.base,
        note: payload.note ? String(payload.note).slice(0, 200) : undefined,
      });
    } catch (e) {
      return fail(res, 500, 'export_failed', `导出失败：${e.message}`);
    }
  }

  return fail(res, 404, 'unknown_api', `未知接口：${pathname}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    return fail(res, 400, 'bad_request', 'URL 无法解析');
  }

  const isApi = url.pathname.startsWith('/api/');
  const method = req.method || 'GET';

  try {
    if (!isApi && method !== 'GET' && method !== 'HEAD') {
      return fail(res, 405, 'method_not_allowed', '静态资源只支持 GET/HEAD');
    }
    if (isApi) {
      if (method !== 'GET' && method !== 'POST') return fail(res, 405, 'method_not_allowed', '仅支持 GET/POST');
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (!res.headersSent) fail(res, 500, 'internal_error', e.message);
    else res.destroy();
  } finally {
    const ms = Date.now() - started;
    if (process.env.DASHBOARD_LOG !== '0') {
      console.log(`${new Date().toISOString()} ${method} ${url.pathname} -> ${res.statusCode} ${ms}ms`);
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用（127.0.0.1）。换一个：PORT=8788 node dashboard/server.js`);
  } else if (err.code === 'EACCES') {
    console.error(`没有权限绑定 ${HOST}:${PORT}。换一个端口或改用 127.0.0.1。`);
  } else {
    console.error('服务启动失败：', err.message);
  }
  process.exit(1);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`bili-learn dashboard  http://${HOST}:${PORT}`);
  console.log(`  仓库：${ROOT}`);
  console.log(`  转写：${displayPath(ROOT, paths.transcriptsDir)}`);
  console.log(`  笔记：${paths.notesDirs.map((d) => displayPath(ROOT, d)).join(' , ')}`);
  console.log(`  帧  ：${displayPath(ROOT, paths.framesDir)}`);
  console.log(`  导出：${displayPath(ROOT, paths.reportsDir)}（唯一写入位置）`);
  if (cfgWarnings.length) for (const w of cfgWarnings) console.log('  ⚠️', w);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，关闭中…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
