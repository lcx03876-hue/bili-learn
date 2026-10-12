// Minimal zero-dependency Chrome/Edge CDP driver (Node >= 22: global fetch + WebSocket).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEFAULT_PORT = 9333;

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export function findBrowser(explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  for (const c of BROWSER_CANDIDATES) if (existsSync(c)) return c;
  throw new Error('no Chrome/Edge executable found');
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function browserVersion(port = DEFAULT_PORT) {
  try {
    return await getJson(`http://127.0.0.1:${port}/json/version`);
  } catch {
    return null;
  }
}

/** Start (or reuse) a browser that exposes CDP on the given port. */
export async function ensureBrowser({ port = DEFAULT_PORT, profileDir, exe, headless = false, extraArgs = [] } = {}) {
  const running = await browserVersion(port);
  if (running) return { port, reused: true, browser: running.Browser, version: running['Protocol-Version'] };

  const bin = findBrowser(exe);
  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1280,800',
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 80; i++) {
    await sleep(400);
    const v = await browserVersion(port);
    if (v) return { port, reused: false, browser: v.Browser, version: v['Protocol-Version'], exe: bin };
  }
  throw new Error(`browser did not expose CDP on port ${port} in time`);
}

export async function listTargets(port = DEFAULT_PORT) {
  return getJson(`http://127.0.0.1:${port}/json/list`);
}

/**
 * 从"进程命令行"文本里挑出属于我们这个 profile 的浏览器进程。
 * 抽成纯函数是为了能单元测试——关窗口是破坏性动作，匹配错了就会误杀用户的浏览器。
 */
export function matchBrowserPids(cmdlines, profileDir) {
  if (!profileDir) return [];
  const dir = String(profileDir).replace(/[\\/]+$/, '');
  const out = [];
  for (const raw of cmdlines ?? []) {
    const line = String(raw ?? '');
    if (!line) continue;
    if (!/chrome\.exe|msedge\.exe/i.test(line)) continue;
    // 匹配 --user-data-dir=<dir>，允许引号与斜杠差异
    const norm = line.replace(/\\/g, '/').replace(/"/g, '');
    const needle = dir.replace(/\\/g, '/');
    const at = norm.indexOf(`--user-data-dir=${needle}`);
    if (at === -1) continue;
    // 路径边界：后面必须是空白或路径分隔符。
    // 否则 `...\profile-backup` 会被 `...\profile` 前缀命中——那是用户的另一个 profile，杀了就是事故。
    const next = norm[at + `--user-data-dir=${needle}`.length];
    if (next != null && next !== '' && !/[\s/]/.test(next)) continue;
    const m = /--remote-debugging-port=(\d+)/.exec(line);
    out.push({ port: m ? Number(m[1]) : null, line: line.slice(0, 120) });
  }
  return out;
}

/**
 * 真机上按 profile 查出我们自己的浏览器 pid（只查询，不关闭）——抽出来是为了能在不关窗口的前提下验证。
 * 必须用 -EncodedCommand：直接拼 -Command 时内层单引号会被剥掉
 * （实测 `Name='chrome.exe'` 变成裸参数 → 查询永远返回空 → 关窗口静默失效）。
 */
export async function findBrowserPids(profileDir, { run = defaultRun } = {}) {
  if (!profileDir) return [];
  const script = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like '*${String(profileDir).replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  return String(out).split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

async function defaultRun(cmd, args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/**
 * 关掉我们自己拉起来的浏览器（按 `--user-data-dir=<profileDir>` 精确匹配）——
 * 绝不误杀用户自己开的 Chrome/Edge。
 * 先试 CDP 的 Browser.close（干净），不行再 taskkill 那些 pid。
 */
export async function closeBrowser(port = DEFAULT_PORT, profileDir) {
  // 先请浏览器自己退（最干净）
  try {
    const v = await browserVersion(port);
    if (v?.webSocketDebuggerUrl) {
      const cdp = await Cdp.connect(v.webSocketDebuggerUrl);
      await cdp.send('Browser.close', {}, { timeoutMs: 5000 }).catch(() => {});
      cdp.close();
      await sleep(800);
      return { closed: true, how: 'Browser.close' };
    }
  } catch { /* 落到 taskkill */ }

  const pids = await findBrowserPids(profileDir);
  if (!pids.length) return { closed: false, reason: 'no-matching-process' };
  for (const pid of pids) await defaultRun('taskkill', ['/PID', String(pid), '/T', '/F']);
  await sleep(800);
  return { closed: true, how: 'taskkill', pids };
}

/** Open a new tab and return its target descriptor (includes webSocketDebuggerUrl). */
export async function newPage(port = DEFAULT_PORT, url = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`/json/new failed: HTTP ${res.status}`);
  return res.json();
}

/** Find the first page target whose url matches, else open a new tab. */
export async function findOrOpenPage(port = DEFAULT_PORT, match = null) {
  const targets = await listTargets(port).catch(() => []);
  const pages = targets.filter((t) => t.type === 'page');
  if (match) {
    const hit = pages.find((t) => t.url.includes(match));
    if (hit) return hit;
  }
  return newPage(port, 'about:blank');
}

export async function closeTarget(port, id) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${id}`);
  } catch {
    /* ignore */
  }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async connect(wsUrl, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`CDP websocket error: ${e.message ?? 'unknown'}`)); }, { once: true });
    });
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (ev) => cdp.#dispatch(ev.data));
    ws.addEventListener('close', () => { cdp.closed = true; });
    return cdp;
  }

  #dispatch(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) {
        try {
          fn(msg.params);
        } catch {
          /* listener errors never break the session */
        }
      }
    }
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  send(method, params = {}, { timeoutMs = 60000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP session closed'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async evaluate(expression, { awaitPromise = true, userGesture = true, timeoutMs = 60000 } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture },
      { timeoutMs },
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page eval failed: ${d.exception?.description ?? d.text ?? 'unknown'}`);
    }
    return r.result?.value;
  }

  async navigate(url, { waitForLoad = true, timeoutMs = 45000 } = {}) {
    await this.send('Page.enable');
    const done = new Promise((resolve) => {
      const off = this.on('Page.loadEventFired', () => { off(); resolve(); });
      setTimeout(() => { off(); resolve(); }, timeoutMs);
    });
    await this.send('Page.navigate', { url });
    if (waitForLoad) await done;
  }

  /** Poll a page expression until it returns truthy. */
  async waitFor(expression, { timeoutMs = 30000, intervalMs = 500, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(intervalMs);
    }
    throw new Error(`waitFor timed out: ${label} (last=${JSON.stringify(last)})`);
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
