// Small DOM + safety helpers shared by all viewer modules.
//
// SECURITY: manifest.json, review.json, diffs and sources all come from a pull request and
// must be treated as untrusted. Never assign data to innerHTML; build nodes with el() and
// textContent, and pass every data-derived URL through safeUrl()/assetUrl().

/** Create an element. attrs: {class, title, href, ...}; children: nodes, strings, null/false (skipped), arrays. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'href' || k === 'src') {
      const safe = k === 'href' ? safeUrl(v) : assetUrl(v);
      if (safe) node.setAttribute(k, safe);
    } else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, children);
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') || '')) {
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
  return node;
}

export function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Only http(s) absolute URLs, or relative asset paths inside the site. Everything else -> null. */
export function safeUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  const s = u.trim();
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).href; } catch { return null; }
  }
  if (s.startsWith('#')) return s;
  return assetUrl(s);
}

/** Relative path inside OUT (e.g. "items/<slug>/head.svg"). Rejects absolute, protocol, "..", backslashes. */
export function assetUrl(p) {
  if (typeof p !== 'string' || !p) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('\\') || p.includes('\\')) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  return p.split('/').map(encodeURIComponent).join('/');
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** https://github.com/<repo>/blob/<sha>/<path>#L<a>-L<b>, or null if any part looks wrong. */
export function githubBlobUrl(repo, sha, path, range) {
  if (!REPO_RE.test(repo || '') || !SHA_RE.test(sha || '') || typeof path !== 'string' || !path) return null;
  if (path.split('/').some((s) => s === '..' || s === '')) return null;
  let url = `https://github.com/${repo}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (Array.isArray(range) && Number.isInteger(range[0])) {
    url += `#L${range[0]}`;
    if (Number.isInteger(range[1]) && range[1] !== range[0]) url += `-L${range[1]}`;
  } else if (Number.isInteger(range)) url += `#L${range}`;
  return url;
}

export function githubUrl(repo, ...parts) {
  if (!REPO_RE.test(repo || '')) return null;
  return `https://github.com/${repo}/${parts.map((p) => encodeURIComponent(String(p))).join('/')}`;
}

export const shortSha = (s) => (typeof s === 'string' ? s.slice(0, 8) : '?');

// --- offline (file://) mode ----------------------------------------------------------------------------
// Opened from a downloaded artifact, browsers refuse fetch() of file:// URLs. build_site.py then provides
// data.js (window.CR_DATA = {manifest, review, texts}) and one offline/<slug>.js per item with the files the
// 3D view needs (window.CR_PACKS[slug] = {files: {<asset url>: {text} | {b64}}}), loaded on demand with <script>.

export const OFFLINE = typeof location !== 'undefined' && location.protocol === 'file:';
const SLUG_RE = /^[A-Za-z0-9._-]{1,200}$/;
const packs = new Map();

/** The per-item pack that holds `url` ("items/<slug>/..."), or null. Loaded once with a <script> tag. */
function packFor(url) {
  const m = /^items\/([^/]+)\//.exec(url || '');
  const slug = m && decodeURIComponent(m[1]);
  if (!slug || !SLUG_RE.test(slug) || slug === '.' || slug === '..') return Promise.resolve(null);
  if (!packs.has(slug)) {
    packs.set(slug, new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = `offline/${encodeURIComponent(slug)}.js`;
      s.onload = () => resolve(window.CR_PACKS?.[slug] || null);
      s.onerror = () => resolve(null);
      document.head.append(s);
    }));
  }
  return packs.get(slug);
}

async function offlineFile(url) {
  const pack = await packFor(url);
  const f = pack?.files && Object.prototype.hasOwnProperty.call(pack.files, url) ? pack.files[url] : null;
  if (!f) throw new Error(`${url} is not available offline`);
  return f;
}

/** Bytes of an asset (e.g. a STEP model). */
export async function fetchBytes(path) {
  const url = assetUrl(path);
  if (!url) throw new Error(`refusing to load ${path}`);
  if (OFFLINE) {
    const f = await offlineFile(url);
    if (typeof f.b64 !== 'string') throw new Error(`${url}: no binary data offline`);
    const bin = atob(f.b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * URL to load an image asset into a canvas/WebGL texture. file:// images taint canvases, so offline the
 * pack's SVG text is turned into a same-origin blob: URL.
 */
export async function imageSrc(path) {
  const url = assetUrl(path);
  if (!url || !OFFLINE) return url;
  const f = await offlineFile(url);
  if (typeof f.text !== 'string') throw new Error(`${url}: not an image offline`);
  return URL.createObjectURL(new Blob([f.text], { type: 'image/svg+xml' }));
}

export async function fetchJson(path) {
  const data = typeof window !== 'undefined' ? window.CR_DATA : null;
  if (data && (path === 'manifest.json' || path === 'review.json')) {
    const v = path === 'manifest.json' ? data.manifest : data.review;
    if (v === null || v === undefined) throw new Error(`${path}: not in data.js`);
    return v;
  }
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

const textCache = new Map();
export function fetchText(path) {
  const url = assetUrl(path);
  if (!url) return Promise.reject(new Error(`refusing to load ${path}`));
  if (!textCache.has(url)) {
    const texts = typeof window !== 'undefined' ? window.CR_DATA?.texts : null;
    if (texts && Object.prototype.hasOwnProperty.call(texts, url)) textCache.set(url, Promise.resolve(String(texts[url])));
    else if (OFFLINE) {
      textCache.set(url, offlineFile(url).then((f) => {
        if (typeof f.text !== 'string') throw new Error(`${url}: not text`);
        return f.text;
      }));
    } else textCache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.text();
    }));
  }
  return textCache.get(url);
}

/**
 * Tiny markdown subset -> DOM (never HTML strings): paragraphs, "- " / "* " / "1. " lists,
 * **bold**, *italic*, `code`, [text](http-url), bare https URLs. Anything else stays literal text.
 */
export function markdown(src) {
  const root = el('div', { class: 'md' });
  if (typeof src !== 'string' || !src.trim()) return root;
  const blocks = src.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || !l.trim())) {
      const ordered = /^\s*\d+\./.test(lines[0]);
      const list = el(ordered ? 'ol' : 'ul');
      for (const l of lines) if (l.trim()) list.append(el('li', {}, inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))));
      root.append(list);
    } else {
      const p = el('p');
      lines.forEach((l, i) => { if (i) p.append(el('br')); append(p, [inline(l)]); });
      root.append(p);
    }
  }
  return root;
}

function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<>]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(el('code', {}, t.slice(1, -1)));
    else if (m[2]) out.push(el('strong', {}, inline(t.slice(2, -2))));
    else if (m[3]) out.push(el('em', {}, inline(t.slice(1, -1))));
    else if (m[4]) {
      const [, label, url] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = /^https?:/i.test(url) ? safeUrl(url) : null;
      out.push(href ? el('a', { href }, label) : `${label} (${url})`);
    } else out.push(el('a', { href: t }, t));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function badge(kind, value, title) {
  if (!value) return null;
  return el('span', { class: `badge ${kind}-${String(value).replace(/[^a-z-]/gi, '')}`, title: title || null }, value);
}

export function fmtNum(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(4));
  return v;
}

/** Stable, readable string for table cells (numbers rounded, arrays joined). */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => cellText(x)).join(v.every((x) => typeof x === 'number') ? ', ' : ' ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(fmtNum(v));
}
