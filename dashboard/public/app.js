/* bili-learn dashboard 前端：原生 JS，无依赖、无 CDN */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('zh-CN'));
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtDur = (sec) => {
    if (!sec) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const fmtSpan = (sec) => {
    if (!sec) return '0 分';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h ? `${h} 小时 ${m} 分` : `${m} 分`;
  };
  const fmtBytes = (b) => {
    if (!b) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  };

  const S = {
    meta: null,
    stats: null,
    videos: null,
    notes: null,
    costs: null,
    reports: [],
    tab: 'overview',
    vq: '',
    vsort: 'mtime',
    vorder: 'desc',
    nq: '',
    review: null,
  };

  async function api(path, opts) {
    const res = await fetch(path, { headers: { accept: 'application/json' }, ...(opts || {}) });
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    if (!res.ok || !json || json.ok !== true) {
      throw new Error((json && json.error && json.error.message) || `HTTP ${res.status}`);
    }
    return json.data;
  }

  function toast(msg, kind = 'info') {
    const box = $('#toast');
    const el = document.createElement('div');
    el.textContent = msg;
    if (kind === 'err') el.style.borderColor = 'rgba(255,92,110,.5)';
    box.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  function banner(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `banner ${kind}`;
    el.innerHTML = text;
    return el;
  }

  // ---------------------------------------------------------------- 加载
  async function loadMeta() {
    S.meta = await api('/api/meta');
    const p = S.meta.paths;
    $('#src-transcripts').textContent = p.transcripts;
    $('#src-notes').textContent = p.notes.join('  ·  ') || '未配置';
    $('#src-frames').textContent = p.frames;
    if (S.meta.warnings && S.meta.warnings.length) {
      const wrap = $('#globalBanner');
      wrap.innerHTML = '';
      wrap.appendChild(banner(S.meta.warnings.map(esc).join('<br>'), 'warn'));
    }
  }

  async function loadStats() {
    S.stats = await api('/api/stats');
    const s = S.stats;
    $('#src-scan').textContent = fmtTime(s.scannedAt);
    $('#scanTime').textContent = `最后扫描 ${fmtTime(s.scannedAt)}`;
    renderOverview();
    renderNotesMeta();
    renderCosts();
  }

  async function loadVideos() {
    const qs = new URLSearchParams({ q: S.vq, sort: S.vsort, order: S.vorder });
    S.videos = await api('/api/videos?' + qs.toString());
    renderVideos();
  }

  async function loadNotes() {
    const qs = new URLSearchParams({ q: S.nq });
    S.notes = await api('/api/notes?' + qs.toString());
    renderNotes();
  }

  async function loadCosts() {
    S.costs = await api('/api/costs');
    renderCosts();
  }

  async function loadReports() {
    try {
      const r = await api('/api/reports');
      S.reports = r.items || [];
    } catch {
      S.reports = [];
    }
    renderReports();
  }

  async function refreshAll() {
    const btn = $('#refresh');
    btn.disabled = true;
    btn.textContent = '扫描中…';
    try {
      await Promise.all([loadMeta(), loadStats(), loadCosts(), loadReports()]);
      await Promise.all([loadVideos(), loadNotes()]);
    } catch (e) {
      toast('加载失败：' + e.message, 'err');
      const wrap = $('#globalBanner');
      wrap.innerHTML = '';
      wrap.appendChild(banner('加载失败：' + esc(e.message) + '（检查服务端日志）', 'err'));
    } finally {
      btn.disabled = false;
      btn.textContent = '重新扫描';
    }
  }

  // ---------------------------------------------------------------- 总览
  function renderOverview() {
    const s = S.stats;
    if (!s) return;
    const c = $('#cards');
    const costVal = s.costs.estimatedFrameYuan != null ? `¥${s.costs.estimatedFrameYuan}` : '—';
    const costSub = s.costs.estimatedFrameYuan != null ? '按 dashboard/costs.json 估算' : '未配置单价';
    c.innerHTML = [
      card('已处理视频', num(s.scope.videos), `${num(s.scope.chars)} 字 · ${num(s.scope.lines)} 行`),
      card('笔记', num(s.scope.notes), `待补 ${num(s.todoCount)} 条`),
      card('平均覆盖率', s.scope.avgCoverage == null ? '—' : `${s.scope.avgCoverage}%`, `${num(s.scope.lowCoverage)} 条低于阈值`, 'pink'),
      card('累计时长', s.scope.durationKnownCount ? fmtSpan(s.scope.durationTotalSec) : '未记录', `${num(s.scope.durationKnownCount)}/${num(s.scope.videos)} 条有记录`),
      card('板书帧', num(s.frames.total), `${num(s.frames.groups.length)} 个分组`, 'cyan'),
      card('预估读图成本', costVal, costSub, s.costs.estimatedFrameYuan == null ? 'warn' : ''),
      card('连续处理', `${num(s.scope.streak)} 天`, `累计活跃 ${num(s.scope.activeDays)} 天`),
    ].join('');

    // 覆盖率
    const known = s.scope.coverageKnown || 0;
    const okN = s.scope.okCoverage || 0;
    const okPct = known ? Math.round((okN / known) * 100) : 0;
    $('#donut').style.setProperty('--p', okPct);
    $('#donutPct').textContent = known ? `${okPct}%` : '—';

    const maxBucket = Math.max(1, ...s.distribution.map((b) => b.count));
    $('#bars').innerHTML = s.distribution
      .map((b) => `<div class="bar-row"><span class="lab">${esc(b.label)}</span><span class="track"><i style="width:${Math.round((b.count / maxBucket) * 100)}%"></i></span><b>${b.count}</b></div>`)
      .join('');

    if (!s.scope.videos) {
      $('#lowList').innerHTML = '<div class="banner info" style="margin:0">还没有可统计的转写文件 —— 检查侧栏「数据来源」里的转写目录。</div>';
    } else if (!s.scope.coverageKnown) {
      $('#lowList').innerHTML = '<div class="banner info" style="margin:0">转写文件里没有「字幕覆盖」标记，无法判断完整性。</div>';
    } else $('#lowList').innerHTML = s.lowVideos.length
      ? `<div class="banner warn" style="margin:0">⚠️ ${s.lowVideos.length} 条字幕覆盖不足：` +
        s.lowVideos.slice(0, 4).map((v) => `${esc(v.bvid || v.title)}（${v.coverage == null ? '?' : v.coverage + '%'}）`).join('、') +
        (s.lowVideos.length > 4 ? ' …' : '') + '</div>'
      : '<div class="banner info" style="margin:0">全部视频的字幕覆盖率都达标 ✅</div>';

    // 热力图
    const heat = $('#heat');
    heat.innerHTML = s.heatmap
      .map((d) => {
        const lv = d.count === 0 ? 0 : d.count === 1 ? 1 : d.count === 2 ? 2 : d.count === 3 ? 3 : 4;
        return `<i class="l${lv}" title="${d.date}：${d.count} 条"></i>`;
      })
      .join('');
    $('#streakLabel').textContent = `连续 ${s.scope.streak} 天 · 活跃 ${s.scope.activeDays} 天`;

    renderReview();
  }

  function card(lab, val, sub, cls = '') {
    return `<div class="card ${cls}"><div class="lab">${esc(lab)}</div><div class="val">${esc(val)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
  }

  function renderReview() {
    const items = S.notes && S.notes.items ? S.notes.items : [];
    if (!items.length) {
      $('#reviewBox').className = 'empty';
      $('#reviewBox').textContent = '还没有笔记可以回顾';
      return;
    }
    if (!S.review || !items.some((n) => n.file === S.review.file)) S.review = items[Math.floor(Math.random() * items.length)];
    const n = S.review;
    const link = n.bvid
      ? `https://www.bilibili.com/video/${encodeURIComponent(n.bvid)}/${n.firstTimestampSec != null ? `?t=${n.firstTimestampSec}` : ''}`
      : null;
    $('#reviewBox').className = '';
    $('#reviewBox').innerHTML = `
      <div class="rt">${esc(n.title)}</div>
      <div class="meta">
        ${n.bvid ? `<span class="badge note">${esc(n.bvid)}</span>` : '<span class="badge none">无 BV</span>'}
        ${n.firstTimestamp ? ` · 时间戳 <span class="mono">${esc(n.firstTimestamp)}</span>` : ''}
        ${link ? ` · <a href="${esc(link)}" target="_blank" rel="noreferrer noopener">在 B 站打开</a>` : ''}
      </div>
      <div class="body mono">${esc(n.file)}</div>`;
  }

  // ---------------------------------------------------------------- 视频
  function renderVideos() {
    const d = S.videos;
    if (!d) return;
    $('#vcount').textContent = `匹配 ${d.matched} / 共 ${d.total} 条`;
    $('#vrows').innerHTML = d.items
      .map((v) => {
        const cov = v.coverage == null
          ? '<span class="badge none">未标注</span>'
          : v.low
            ? `<span class="badge low">⚠️ ${v.coverage}%</span>`
            : `<span class="badge ok">${v.coverage}%</span>`;
        return `<tr>
          <td>${esc(v.title)}</td>
          <td class="mono">${v.bvid ? esc(v.bvid) : '<span class="badge none">—</span>'}</td>
          <td>${cov}</td>
          <td class="num">${fmtDur(v.durationSec)}</td>
          <td class="num">${num(v.chars)}</td>
          <td class="num">${num(v.lines)}</td>
          <td>${v.noteCount ? `<span class="badge note">${v.noteCount}</span>` : '<span class="badge none">缺</span>'}</td>
          <td class="num">${fmtTime(v.modifiedAt)}</td>
        </tr>`;
      })
      .join('');
    $('#vempty').style.display = d.items.length ? 'none' : 'block';
  }

  // ---------------------------------------------------------------- 笔记
  function renderNotesMeta() {
    const s = S.stats;
    if (!s) return;
    $('#noteCards').innerHTML = [
      card('笔记总数', num(s.scope.notes), '含 examples/ 与 notes/'),
      card('已有笔记的视频', num(s.withNote), `共 ${num(s.scope.videos)} 条转写`),
      card('待补笔记', num(s.todoCount), '有转写、还没写', s.todoCount ? 'warn' : ''),
      card('标签数', num(s.tags.length), '来自 #标签'),
    ].join('');

    const maxWeek = Math.max(1, ...s.weeks.map((w) => w.count));
    $('#weeks').innerHTML = s.weeks
      .map((w) => `<div class="b" title="${w.key}：${w.count}"><i style="height:${Math.round((w.count / maxWeek) * 100)}%"></i><span>${esc(w.label)}</span></div>`)
      .join('');

    $('#cloud').innerHTML = s.tags.length
      ? s.tags.map((t) => `<span class="${t.count > 1 ? 'hot' : ''}" title="${esc(t.tag)} × ${t.count}">${esc(t.tag)} <b style="color:var(--dim2);font-weight:400">${t.count}</b></span>`).join('')
      : '<div class="empty">还没有 #标签</div>';

    $('#todoTag').textContent = `${s.todoCount} 条待补`;
    $('#todoRows').innerHTML = s.todo
      .map((t) => `<tr>
        <td class="mono">${t.bvid ? esc(t.bvid) : '<span class="badge none">—</span>'}</td>
        <td>${esc(t.title)}</td>
        <td>${t.coverage == null ? '<span class="badge none">—</span>' : `<span class="badge ${t.coverage < 80 ? 'low' : 'ok'}">${t.coverage}%</span>`}</td>
        <td class="num">${num(t.chars)}</td>
        <td class="num">${fmtTime(t.modifiedAt)}</td>
      </tr>`)
      .join('');
    $('#todoEmpty').style.display = s.todo.length ? 'none' : 'block';
  }

  function renderNotes() {
    const d = S.notes;
    if (!d) return;
    $('#noteCount').textContent = `匹配 ${d.matched} / 共 ${d.total}`;
    $('#nrows').innerHTML = d.items
      .map((n) => `<tr>
        <td>${esc(n.title)}</td>
        <td class="mono">${n.bvid ? esc(n.bvid) : '<span class="badge none">—</span>'}</td>
        <td>${n.tags.length ? n.tags.slice(0, 4).map((t) => `<span class="badge none">${esc(t)}</span>`).join(' ') : '—'}</td>
        <td class="num">${num(n.chars)}</td>
        <td class="num">${fmtTime(n.modifiedAt)}</td>
        <td class="path">${esc(n.file)}</td>
      </tr>`)
      .join('');
    $('#nempty').style.display = d.items.length ? 'none' : 'block';
    renderReview();
  }

  // ---------------------------------------------------------------- 成本
  function renderCosts() {
    const s = S.stats;
    const c = S.costs;
    if (!s || !c) return;
    const costs = c.costs;

    const wrap = $('#costBanner');
    wrap.innerHTML = '';
    if (!costs.configExists) {
      wrap.appendChild(banner('未配置单价，<b>不估算金额</b>。把单价写进 <code>dashboard/costs.json</code> 后这里会自动出现预估。', 'warn'));
    } else if (costs.perFrameYuan == null) {
      wrap.appendChild(banner('单价配置里没有可用字段（需要 <code>yuanPerFrame</code>，或 <code>yuanPer1kTokens</code> + <code>tokensPerFrame</code>）。', 'warn'));
    } else {
      wrap.appendChild(banner(`按 <code>${esc(costs.configFile)}</code> 的单价估算：每帧 ¥${costs.perFrameYuan}`, 'info'));
    }

    $('#costCards').innerHTML = [
      card('板书帧总数', num(c.frames.total), `${num(c.frames.groups.length)} 个分组`),
      card('帧体积', fmtBytes(c.frames.totalBytes), '磁盘占用'),
      card('预估读图成本', costs.estimatedFrameYuan != null ? `¥${costs.estimatedFrameYuan}` : '—', costs.estimatedFrameYuan != null ? '按配置单价' : '未配置单价', costs.estimatedFrameYuan == null ? 'warn' : 'cyan'),
      card('手工成本合计', costs.manualTotalYuan != null ? `¥${costs.manualTotalYuan}` : '—', costs.manualTotalYuan != null ? `${costs.manualMonths.length} 个月` : '暂无记录'),
    ].join('');

    $('#frameTag').textContent = c.frames.exists ? `${c.frames.total} 张` : '目录不存在';
    $('#frameRows').innerHTML = c.frames.costs
      .map((g) => `<tr>
        <td class="mono">${esc(g.name)}</td>
        <td class="mono">${g.bvid ? esc(g.bvid) : '—'}</td>
        <td class="num">${num(g.frames)}</td>
        <td class="num">${fmtBytes(c.frames.groups.find((x) => x.name === g.name)?.bytes)}</td>
        <td class="num">${g.estimatedYuan != null ? `¥${g.estimatedYuan}` : '—'}</td>
      </tr>`)
      .join('');
    $('#frameEmpty').style.display = c.frames.costs.length ? 'none' : 'block';

    $('#manualRows').innerHTML = costs.manualMonths.map((m) => `<tr><td class="mono">${esc(m.month)}</td><td class="num">¥${m.yuan}</td></tr>`).join('');
    $('#manualEmpty').style.display = costs.manualMonths.length ? 'none' : 'block';
  }

  // ---------------------------------------------------------------- 导出
  function renderReports() {
    const rows = S.reports || [];
    $('#reportRows').innerHTML = rows
      .map((r) => `<tr>
        <td class="mono">${esc(r.name)}</td>
        <td class="num">${fmtBytes(r.size)}</td>
        <td class="num">${fmtTime(r.modifiedAt)}</td>
      </tr>`)
      .join('');
    $('#reportEmpty').style.display = rows.length ? 'none' : 'block';
  }

  async function doExport() {
    const btn = $('#doExport');
    btn.disabled = true;
    $('#exportState').textContent = '生成中…';
    $('#exportResult').innerHTML = '';
    try {
      const r = await api('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      $('#exportResult').innerHTML = `<div class="banner info" style="margin:0">
        已写入：<br><code>${esc(r.markdown)}</code><br><code>${esc(r.html)}</code>
      </div>`;
      toast('报告已生成');
      await loadReports();
    } catch (e) {
      $('#exportResult').innerHTML = `<div class="banner err" style="margin:0">导出失败：${esc(e.message)}</div>`;
      toast('导出失败', 'err');
    } finally {
      btn.disabled = false;
      $('#exportState').textContent = '';
    }
  }

  // ---------------------------------------------------------------- 标签页
  const TITLES = {
    overview: ['总览', '本地只读聚合 · 不读取 data/profile · 不发任何外部请求'],
    videos: ['视频', '扫描转写目录，解析 BV / 覆盖率 / 字数'],
    notes: ['笔记', '关联转写与笔记，找出还没写笔记的视频'],
    costs: ['成本', '帧数来自本地目录；金额只按你配置的单价估算'],
    export: ['导出', '生成 Markdown + HTML 报告，只写入 reports/'],
  };

  function setTab(tab) {
    S.tab = tab;
    $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + tab));
    const [t, sub] = TITLES[tab] || ['', ''];
    $('#pageTitle').textContent = t;
    $('#pageSub').textContent = sub;
  }

  // ---------------------------------------------------------------- 事件
  function bind() {
    $('#nav').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (b) setTab(b.dataset.tab);
    });
    $('#refresh').addEventListener('click', refreshAll);
    $('#reroll').addEventListener('click', () => { S.review = null; renderReview(); });

    let t = null;
    $('#vq').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => { S.vq = e.target.value; loadVideos().catch((er) => toast(er.message, 'err')); }, 220);
    });
    $('#vsort').addEventListener('change', (e) => { S.vsort = e.target.value; loadVideos().catch((er) => toast(er.message, 'err')); });
    $('#vorder').addEventListener('click', (e) => {
      S.vorder = S.vorder === 'desc' ? 'asc' : 'desc';
      e.target.textContent = S.vorder === 'desc' ? '↓ 降序' : '↑ 升序';
      loadVideos().catch((er) => toast(er.message, 'err'));
    });

    let tn = null;
    $('#nq').addEventListener('input', (e) => {
      clearTimeout(tn);
      tn = setTimeout(() => { S.nq = e.target.value; loadNotes().catch((er) => toast(er.message, 'err')); }, 220);
    });

    $('#doExport').addEventListener('click', doExport);
  }

  // ---------------------------------------------------------------- 启动
  bind();
  refreshAll();
})();
