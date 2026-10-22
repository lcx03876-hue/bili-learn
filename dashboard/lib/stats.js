// 聚合层：把扫描结果算成前端/报告要用的结构。纯函数，不碰文件系统。
import { relative, resolve } from 'node:path';

const DAY = 24 * 3600 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
/** 周一为一周起点 */
function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;
  return d.getTime() - dow * DAY;
}

const BUCKETS = [
  { label: '未标注', test: (c) => c == null },
  { label: '<60%', test: (c) => c != null && c < 60 },
  { label: '60–79%', test: (c) => c >= 60 && c < 80 },
  { label: '80–89%', test: (c) => c >= 80 && c < 90 },
  { label: '90–99%', test: (c) => c >= 90 && c < 100 },
  { label: '100%', test: (c) => c === 100 },
];

export function buildStats({ transcripts, notes, frames, costs, cfg, paths, repoRoot, scannedAt }) {
  const videos = transcripts.items;
  const noteList = notes.items;

  const coverageKnown = videos.filter((v) => v.coverage != null);
  const avgCoverage = coverageKnown.length
    ? Math.round((coverageKnown.reduce((n, v) => n + v.coverage, 0) / coverageKnown.length) * 10) / 10
    : null;

  const distribution = BUCKETS.map((b) => ({
    label: b.label,
    count: videos.filter((v) => b.test(v.coverage)).length,
  }));

  const lowVideos = videos.filter((v) => v.low).sort((a, b) => (a.coverage ?? 999) - (b.coverage ?? 999));
  const durationTotalSec = videos.reduce((n, v) => n + (v.durationSec || 0), 0);
  const durationKnownCount = videos.filter((v) => v.durationSec).length;

  const notesByBvid = new Map();
  for (const n of noteList) {
    if (!n.bvid) continue;
    if (!notesByBvid.has(n.bvid)) notesByBvid.set(n.bvid, []);
    notesByBvid.get(n.bvid).push(n);
  }
  const withNote = videos.filter((v) => v.bvid && notesByBvid.has(v.bvid)).length;
  const todo = videos
    .filter((v) => !v.bvid || !notesByBvid.has(v.bvid))
    .map((v) => ({
      bvid: v.bvid,
      title: v.title,
      coverage: v.coverage,
      modifiedAt: v.modifiedAt,
      lines: v.lines,
      chars: v.chars,
      file: rel(repoRoot, v.file),
    }));

  // 热力图：最近 365 天
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - 364 * DAY);
  const counts = new Map();
  for (const v of videos) {
    const k = dayKey(v.mtime);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const heatmap = [];
  for (let t = start.getTime(); t <= today.getTime(); t += DAY) {
    const k = dayKey(t);
    heatmap.push({ date: k, count: counts.get(k) || 0 });
  }

  // 连续天数：从今天（或昨天）往前数有记录的天
  let streak = 0;
  let cursor = today.getTime();
  if (!counts.get(dayKey(cursor))) cursor -= DAY;
  while (counts.get(dayKey(cursor))) {
    streak++;
    cursor -= DAY;
  }

  // 笔记趋势
  const weekMap = new Map();
  const monthMap = new Map();
  for (const n of noteList) {
    const wk = weekStart(n.mtime);
    weekMap.set(wk, (weekMap.get(wk) || 0) + 1);
    const mk = monthKey(n.mtime);
    monthMap.set(mk, (monthMap.get(mk) || 0) + 1);
  }
  const weeks = [];
  const thisWeek = weekStart(Date.now());
  for (let i = 11; i >= 0; i--) {
    const t = thisWeek - i * 7 * DAY;
    const d = new Date(t);
    weeks.push({ key: dayKey(t), label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, count: weekMap.get(t) || 0 });
  }
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    months.push({ key: k, label: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, count: monthMap.get(k) || 0 });
  }

  // 标签云
  const tagMap = new Map();
  for (const n of noteList) for (const t of n.tags) tagMap.set(t, (tagMap.get(t) || 0) + 1);
  const tags = [...tagMap.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 60);

  // 帧与成本
  const frameGroups = frames.groups.map((g) => ({
    ...g,
    noteCount: g.bvid ? (notesByBvid.get(g.bvid) || []).length : 0,
    title: (g.bvid && videos.find((v) => v.bvid === g.bvid)?.title) || null,
  }));
  const perFrame = costs.perFrameYuan;
  const estimatedFrameYuan = perFrame != null ? Math.round(perFrame * frames.total * 10000) / 10000 : null;
  const frameCosts = frameGroups.map((g) => ({
    name: g.name,
    bvid: g.bvid,
    frames: g.frames,
    estimatedYuan: perFrame != null ? Math.round(perFrame * g.frames * 10000) / 10000 : null,
  }));

  const manualMonthly = new Map();
  for (const r of costs.manual) manualMonthly.set(r.month, (manualMonthly.get(r.month) || 0) + r.yuan);
  const manualMonths = [...manualMonthly.entries()]
    .map(([month, yuan]) => ({ month, yuan: Math.round(yuan * 100) / 100 }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  return {
    generatedAt: new Date().toISOString(),
    scannedAt,
    repoRoot,
    scope: {
      videos: videos.length,
      chars: videos.reduce((n, v) => n + v.chars, 0),
      lines: videos.reduce((n, v) => n + v.lines, 0),
      notes: noteList.length,
      frames: frames.total,
      avgCoverage,
      lowCoverage: lowVideos.length,
      okCoverage: coverageKnown.length - lowVideos.length,
      coverageKnown: coverageKnown.length,
      durationTotalSec,
      durationKnownCount,
      streak,
      activeDays: counts.size,
    },
    distribution,
    lowVideos: lowVideos.map((v) => ({
      bvid: v.bvid,
      title: v.title,
      coverage: v.coverage,
      file: rel(repoRoot, v.file),
      modifiedAt: v.modifiedAt,
    })),
    heatmap,
    weeks,
    months,
    tags,
    todo,
    todoCount: todo.length,
    withNote,
    frames: {
      dir: rel(repoRoot, frames.dir),
      exists: frames.exists,
      total: frames.total,
      totalBytes: frames.totalBytes,
      groups: frameGroups.map((g) => ({ ...g, file: undefined })),
      costs: frameCosts,
    },
    costs: {
      configFile: rel(repoRoot, costs.configFile),
      configExists: costs.configExists,
      yuanPerFrame: costs.yuanPerFrame,
      yuanPer1kTokens: costs.yuanPer1kTokens,
      tokensPerFrame: costs.tokensPerFrame,
      perFrameYuan: perFrame,
      estimatedFrameYuan,
      manualFile: rel(repoRoot, costs.manualFile),
      manualExists: costs.manualExists,
      manualMonths,
      manualTotalYuan: costs.manualTotalYuan,
      warnings: costs.warnings,
    },
    sources: {
      transcripts: rel(repoRoot, transcripts.dir),
      transcriptsExists: transcripts.exists,
      notesDirs: notes.dirs.map((d) => rel(repoRoot, d)),
      notesScanned: notes.scanned.map((s) => ({ dir: rel(repoRoot, s.dir), exists: s.exists, count: s.count })),
      frames: rel(repoRoot, frames.dir),
    },
    errors: [...transcripts.errors, ...notes.errors, ...frames.errors].map((e) => ({
      file: rel(repoRoot, e.file),
      message: e.message,
    })),
  };
}

function rel(root, p) {
  const r = relative(resolve(root), resolve(p));
  return (r === '' ? '.' : r).replace(/\\/g, '/');
}
