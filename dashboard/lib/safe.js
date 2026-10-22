// 路径安全：所有"由外部输入拼接路径"的地方都必须走这里。
// 本项目对 HTTP 层不暴露任何路径参数，这层是纵深防御（静态文件 / 未来扩展）。
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** target 是否位于 root 之内（允许 root 本身）。 */
export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith('..' + sep) && rel !== '..' && !rel.split(sep).includes('..');
}

/** 在 root 内拼接路径；越界直接抛错。 */
export function safeJoin(root, ...parts) {
  const p = resolve(root, ...parts);
  if (!isInside(root, p)) {
    const err = new Error('路径越界');
    err.code = 'EPATH';
    throw err;
  }
  return p;
}

/** 把 URL 路径解成安全的相对路径（拒绝 %2e%2e、绝对路径、反斜杠穿越）。 */
export function safeRelative(urlPathname) {
  let p;
  try {
    p = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  p = p.replace(/\\/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  if (p === '') return 'index.html';
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  const n = normalize(p);
  if (n.startsWith('..') || isAbsolute(n)) return null;
  return n;
}

/** 隐藏敏感路径的绝对前缀，用于前端展示。 */
export function displayPath(root, p) {
  const rel = relative(resolve(root), resolve(p));
  return rel === '' ? '.' : rel.replace(/\\/g, '/');
}
