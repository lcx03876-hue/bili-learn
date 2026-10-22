// 配置加载：只读 dashboard.config.json（可选），路径一律相对仓库根解析。
// 安全约定：配置文件里可以写绝对路径（比如把笔记放在仓库外），但**绝不接受来自 HTTP 请求的路径**。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside } from './safe.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根（dashboard/lib/../..） */
export const ROOT = resolve(HERE, '..', '..');
/** dashboard 目录 */
export const DASH = resolve(HERE, '..');
export const PUBLIC_DIR = join(DASH, 'public');
export const CONFIG_FILE = process.env.DASHBOARD_CONFIG
  ? resolve(process.env.DASHBOARD_CONFIG)
  : join(DASH, 'dashboard.config.json');

const DEFAULTS = {
  transcriptsDir: 'data/out/transcripts',
  framesDir: 'data/frames',
  notesDirs: ['notes', 'examples'],
  reportsDir: 'reports',
  costsFile: 'dashboard/costs.json',
  manualCostsFile: 'dashboard/manual-costs.json',
  /** 覆盖率低于该值视为"不完整" */
  lowCoverageThreshold: 0.8,
  /** 标签：#中文/字母/数字/下划线/连字符 */
  tagPattern: '#[\\p{L}\\p{N}_-]{1,24}',
  /** 扫描时跳过的目录名（相对仓库根或绝对路径都按 basename + 相对路径双重匹配） */
  ignoreDirs: ['node_modules', '.git', 'data/profile'],
  /** 单文件读取上限，防止误读巨大文件 */
  maxFileBytes: 4 * 1024 * 1024,
  /** 笔记递归深度 */
  maxNoteDepth: 8,
  /** 单次扫描结果复用窗口（毫秒） */
  scanCacheMs: 1500,
};

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function abs(p, base) {
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** 读取可选配置；损坏时回退默认值并给出警告，不崩溃。 */
export function loadConfig() {
  const warnings = [];
  let user = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(stripBom(readFileSync(CONFIG_FILE, 'utf8')));
      if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('顶层必须是对象');
    } catch (e) {
      warnings.push(`dashboard.config.json 解析失败，已回退默认配置：${e.message}`);
      user = {};
    }
  }

  const cfg = { ...DEFAULTS, ...user };

  // 数值兜底
  cfg.lowCoverageThreshold = clamp01(Number(cfg.lowCoverageThreshold), DEFAULTS.lowCoverageThreshold);
  cfg.maxFileBytes = Number(cfg.maxFileBytes) || DEFAULTS.maxFileBytes;
  cfg.maxNoteDepth = Number(cfg.maxNoteDepth) || DEFAULTS.maxNoteDepth;
  cfg.scanCacheMs = Number(cfg.scanCacheMs) || DEFAULTS.scanCacheMs;
  if (!Array.isArray(cfg.notesDirs) || cfg.notesDirs.length === 0) cfg.notesDirs = DEFAULTS.notesDirs.slice();
  if (!Array.isArray(cfg.ignoreDirs)) cfg.ignoreDirs = DEFAULTS.ignoreDirs.slice();
  if (typeof cfg.tagPattern !== 'string' || !cfg.tagPattern) cfg.tagPattern = DEFAULTS.tagPattern;
  try {
    cfg.tagRegex = new RegExp(cfg.tagPattern, 'gu');
  } catch {
    warnings.push('tagPattern 不是合法正则，已用默认值');
    cfg.tagRegex = new RegExp(DEFAULTS.tagPattern, 'gu');
  }

  // 纵深防御：任何扫描/写入路径都不许落在 data/profile（登录态）里
  const PROTECTED = join(ROOT, 'data', 'profile');
  const guard = (p, label) => {
    if (isInside(PROTECTED, p) || isInside(p, PROTECTED)) {
      warnings.push(`${label} 指向 data/profile，已拒绝并禁用`);
      return join(ROOT, '.dashboard-blocked', label);
    }
    return p;
  };

  const paths = {
    transcriptsDir: guard(abs(cfg.transcriptsDir, ROOT), 'transcriptsDir'),
    framesDir: guard(abs(cfg.framesDir, ROOT), 'framesDir'),
    notesDirs: cfg.notesDirs.map((d) => guard(abs(d, ROOT), 'notesDir')),
    reportsDir: guard(abs(cfg.reportsDir, ROOT), 'reportsDir'),
    costsFile: guard(abs(cfg.costsFile, ROOT), 'costsFile'),
    manualCostsFile: guard(abs(cfg.manualCostsFile, ROOT), 'manualCostsFile'),
  };

  cfg.__root = ROOT;
  return { cfg, paths, warnings, configFile: CONFIG_FILE, hasConfig: existsSync(CONFIG_FILE) };
}

function clamp01(n, dflt) {
  if (!Number.isFinite(n) || n <= 0 || n > 1) return dflt;
  return n;
}

export { DEFAULTS };
