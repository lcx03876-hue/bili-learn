// 报告导出：唯一允许写盘的地方，只写 reports/ 下、只新建文件（flag: wx），绝不覆盖。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function hms(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function pct(n) {
  return n == null ? '—' : `${n}%`;
}

function range(snapshot, videos) {
  const times = videos.map((v) => v.mtime).filter(Boolean);
  if (!times.length) return '—（暂无数据）';
  const a = Math.min(...times);
  const b = Math.max(...times);
  return `${fmtDate(new Date(a).toISOString())} ~ ${fmtDate(new Date(b).toISOString())}`;
}

export function buildMarkdown(snapshot, videos, notes) {
  const s = snapshot;
  const lines = [];
  const now = new Date();

  lines.push(`# bili-learn 学习报告`, '');
  lines.push(`- 生成时间：${fmtDate(now.toISOString())}`);
  lines.push(`- 统计时间范围（按转写文件修改时间）：${range(s, videos)}`);
  lines.push(`- 数据来源：\`${s.sources.transcripts}\`（转写）、\`${s.sources.notesDirs.join('`、`') || '未配置'}\`（笔记）、\`${s.sources.frames}\`（帧）`);
  lines.push(`- 本次扫描：${fmtDate(s.scannedAt)}`, '');

  lines.push(`## 一、视频`, '');
  lines.push(`| 指标 | 数值 |`, `|---|---|`);
  lines.push(`| 已处理视频 | ${s.scope.videos} |`);
  lines.push(`| 字幕总字数 / 行数 | ${s.scope.chars} 字 / ${s.scope.lines} 行 |`);
  lines.push(`| 平均覆盖率 | ${pct(s.scope.avgCoverage)} |`);
  lines.push(`| 低覆盖率（⚠️） | ${s.scope.lowCoverage} |`);
  lines.push(`| 已知时长合计 | ${hms(s.scope.durationTotalSec)}（${s.scope.durationKnownCount}/${s.scope.videos} 条有记录） |`);
  lines.push('');

  lines.push(`### 覆盖率分布`, '');
  lines.push(`| 区间 | 数量 |`, `|---|---|`);
  for (const b of s.distribution) lines.push(`| ${b.label} | ${b.count} |`);
  lines.push('');

  if (s.lowVideos.length) {
    lines.push(`### ⚠️ 低覆盖率视频`, '');
    for (const v of s.lowVideos) lines.push(`- \`${v.bvid || '?'}\` ${v.title} — 覆盖 ${pct(v.coverage)}（${fmtDate(v.modifiedAt)}）`);
    lines.push('');
  }

  lines.push(`## 二、笔记`, '');
  lines.push(`| 指标 | 数值 |`, `|---|---|`);
  lines.push(`| 笔记总数 | ${s.scope.notes} |`);
  lines.push(`| 已有笔记的视频 | ${s.withNote} |`);
  lines.push(`| 有转写但无笔记 | ${s.todoCount} |`);
  lines.push('');

  if (s.todoCount) {
    lines.push(`### 待补笔记`, '');
    lines.push(`| BV | 标题 | 覆盖率 | 字数 | 处理时间 |`, `|---|---|---|---|---|`);
    for (const t of s.todo) {
      lines.push(`| \`${t.bvid || '?'}\` | ${t.title} | ${pct(t.coverage)} | ${t.chars} | ${fmtDate(t.modifiedAt)} |`);
    }
    lines.push('');
  }

  if (s.tags.length) {
    lines.push(`### 标签`, '');
    lines.push(s.tags.slice(0, 30).map((t) => `\`${t.tag}\`×${t.count}`).join('、'), '');
  }

  lines.push(`## 三、帧与成本`, '');
  lines.push(`| 指标 | 数值 |`, `|---|---|`);
  lines.push(`| 帧总数 | ${s.frames.total} |`);
  lines.push(`| 分组数 | ${s.frames.groups.length} |`);
  lines.push(`| 单价配置 | ${s.costs.configExists ? `\`${s.costs.configFile}\`` : '未配置'} |`);
  lines.push(`| 预估读图成本 | ${s.costs.estimatedFrameYuan != null ? `¥${s.costs.estimatedFrameYuan}` : '未配置单价，不估算金额'} |`);
  lines.push(`| 手工成本记录合计 | ${s.costs.manualTotalYuan != null ? `¥${s.costs.manualTotalYuan}` : '暂无手工成本记录'} |`);
  lines.push('');

  if (s.frames.groups.length) {
    lines.push(`### 按视频的帧数`, '');
    lines.push(`| 分组 | BV | 帧数 | 预估成本 |`, `|---|---|---|---|`);
    for (const g of s.frames.costs) {
      lines.push(`| ${g.name} | \`${g.bvid || '—'}\` | ${g.frames} | ${g.estimatedYuan != null ? `¥${g.estimatedYuan}` : '—'} |`);
    }
    lines.push('');
  }

  if (s.costs.manualMonths.length) {
    lines.push(`### 手工成本（按月）`, '');
    lines.push(`| 月份 | 金额 |`, `|---|---|`);
    for (const m of s.costs.manualMonths) lines.push(`| ${m.month} | ¥${m.yuan} |`);
    lines.push('');
  }

  lines.push(`## 四、按日处理热力图数据`, '');
  const active = s.heatmap.filter((d) => d.count > 0);
  lines.push(`- 有处理记录的天数：${active.length}`);
  lines.push(`- 连续处理天数：${s.scope.streak}`);
  lines.push('');
  if (active.length) {
    lines.push(`| 日期 | 处理视频数 |`, `|---|---|`);
    for (const d of active.slice(-31)) lines.push(`| ${d.date} | ${d.count} |`);
    lines.push('');
  } else {
    lines.push('（暂无按日数据）', '');
  }

  lines.push(`---`, '', `由 bili-learn dashboard 生成；只读导出，未修改任何源文件。`, '');
  return lines.join('\n');
}

export function buildHtml(snapshot, videos, notes) {
  const s = snapshot;
  const md = buildMarkdown(snapshot, videos, notes);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const bar = (b, max) => {
    const w = max ? Math.round((b.count / max) * 100) : 0;
    return `<div class="row"><span class="lab">${esc(b.label)}</span><span class="track"><i style="width:${w}%"></i></span><b>${b.count}</b></div>`;
  };
  const maxBucket = Math.max(1, ...s.distribution.map((b) => b.count));
  const heat = s.heatmap
    .map((d) => `<span class="cell l${d.count === 0 ? 0 : Math.min(4, d.count)}" title="${d.date}：${d.count} 条"></span>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>bili-learn 学习报告 ${esc(fmtDate(s.generatedAt))}</title>
<style>
  :root{--bg:#0b0d12;--card:#12151d;--ink:#e8edf6;--dim:#8b94a7;--pink:#fb7299;--cyan:#2cc7e8;--line:#232838}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,"Segoe UI","Noto Sans SC",sans-serif}
  .wrap{max-width:960px;margin:0 auto;padding:48px 24px}
  h1{font-size:30px;margin:0 0 8px}h2{font-size:20px;margin:38px 0 12px;border-left:3px solid var(--pink);padding-left:10px}
  .meta{color:var(--dim);font-size:13px;margin-bottom:8px}
  table{border-collapse:collapse;width:100%;margin:10px 0 18px;font-size:14px}
  th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}th{color:var(--dim);font-weight:500}
  code{background:#1b2030;padding:1px 6px;border-radius:5px;font-size:13px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .card b{display:block;font-size:24px;margin-top:2px}
  .card span{color:var(--dim);font-size:12px;letter-spacing:1px}
  .row{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px}
  .row .lab{width:70px;color:var(--dim)}.row b{width:36px;text-align:right}
  .track{flex:1;height:8px;background:#1b2030;border-radius:4px;overflow:hidden}
  .track i{display:block;height:100%;background:linear-gradient(90deg,var(--pink),var(--cyan))}
  .heat{display:grid;grid-template-columns:repeat(53,10px);grid-auto-rows:10px;gap:3px;margin:12px 0}
  .cell{width:10px;height:10px;border-radius:2px;background:#161a24}
  .cell.l1{background:#2a3f4a}.cell.l2{background:#2f6b7a}.cell.l3{background:#3aa0b8}.cell.l4{background:var(--cyan)}
  .warn{border-left:3px solid #f3b33f;background:#1a1710;padding:10px 14px;border-radius:6px;color:#e9d9b5;margin:12px 0}
  .foot{margin-top:40px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
  pre{background:#0f131b;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font-size:12px;color:#b9c3d6}
</style></head><body><div class="wrap">
  <h1>bili-learn 学习报告</h1>
  <div class="meta">生成时间：${esc(fmtDate(s.generatedAt))} · 统计范围：${esc(range(s, videos))}</div>
  <div class="meta">数据来源：${esc(s.sources.transcripts)} · ${esc(s.sources.notesDirs.join(' / ') || '未配置笔记目录')} · ${esc(s.sources.frames)}</div>

  <div class="cards">
    <div class="card"><span>已处理视频</span><b>${s.scope.videos}</b></div>
    <div class="card"><span>笔记</span><b>${s.scope.notes}</b></div>
    <div class="card"><span>平均覆盖率</span><b>${s.scope.avgCoverage == null ? '—' : s.scope.avgCoverage + '%'}</b></div>
    <div class="card"><span>帧总数</span><b>${s.frames.total}</b></div>
    <div class="card"><span>连续天数</span><b>${s.scope.streak}</b></div>
  </div>

  <h2>覆盖率分布</h2>
  ${s.distribution.map((b) => bar(b, maxBucket)).join('')}
  ${s.lowVideos.length ? `<div class="warn">⚠️ ${s.lowVideos.length} 条视频字幕覆盖不足 80%：${esc(s.lowVideos.map((v) => v.bvid || v.title).join('、'))}</div>` : ''}

  <h2>待补笔记（${s.todoCount}）</h2>
  ${s.todoCount ? `<table><tr><th>BV</th><th>标题</th><th>覆盖率</th><th>处理时间</th></tr>${s.todo
    .map((t) => `<tr><td><code>${esc(t.bvid || '?')}</code></td><td>${esc(t.title)}</td><td>${t.coverage == null ? '—' : t.coverage + '%'}</td><td>${esc(fmtDate(t.modifiedAt))}</td></tr>`)
    .join('')}</table>` : '<p class="meta">全部都有笔记 🎉</p>'}

  <h2>帧与成本</h2>
  <table>
    <tr><th>帧总数</th><td>${s.frames.total}</td></tr>
    <tr><th>单价配置</th><td>${s.costs.configExists ? `<code>${esc(s.costs.configFile)}</code>` : '未配置'}</td></tr>
    <tr><th>预估读图成本</th><td>${s.costs.estimatedFrameYuan != null ? '¥' + s.costs.estimatedFrameYuan : '未配置单价，不估算金额'}</td></tr>
    <tr><th>手工成本合计</th><td>${s.costs.manualTotalYuan != null ? '¥' + s.costs.manualTotalYuan : '暂无手工成本记录'}</td></tr>
  </table>

  <h2>按日处理热力图</h2>
  <div class="heat">${heat}</div>
  <div class="meta">有记录 ${s.heatmap.filter((d) => d.count).length} 天 · 连续 ${s.scope.streak} 天</div>

  <h2>原始 Markdown</h2>
  <pre>${esc(md)}</pre>
  <div class="foot">由 bili-learn dashboard 生成 · 只读导出，未修改任何源文件</div>
</div></body></html>`;
}

/** 写入 reports/：只新建，不覆盖。 */
export async function writeReport(snapshot, videos, notes, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const base = `learning-report-${stamp(new Date())}`;
  const md = buildMarkdown(snapshot, videos, notes);
  const html = buildHtml(snapshot, videos, notes);

  let mdPath = join(reportsDir, `${base}.md`);
  let htmlPath = join(reportsDir, `${base}.html`);
  let i = 2;
  for (;;) {
    try {
      await writeFile(mdPath, md, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      mdPath = join(reportsDir, `${base}-${i}.md`);
      htmlPath = join(reportsDir, `${base}-${i}.html`);
      i++;
      if (i > 50) throw new Error('无法生成唯一报告文件名');
    }
  }
  try {
    await writeFile(htmlPath, html, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      htmlPath = join(reportsDir, `${base}-${i}.html`);
      await writeFile(htmlPath, html, { encoding: 'utf8', flag: 'wx' });
    } else throw e;
  }
  return { md: mdPath, html: htmlPath, base };
}
