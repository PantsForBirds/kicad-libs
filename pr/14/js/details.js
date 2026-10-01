// Details: properties / pads / pins / stats diffs, datasheet, 3D model paths, warnings, text diff.
import { el, clear, fetchText, githubBlobUrl, cellText, badge, safeUrl, assetUrl } from './util.js';

const section = (title, ...body) => el('section', { class: 'card' }, el('h3', {}, title), ...body);

function sideCols(item) {
  const cols = [];
  if (item.status !== 'added') cols.push('base');
  if (item.status !== 'deleted') cols.push('head');
  return cols;
}

/** key | base | head table; rows whose values differ are highlighted. */
function kvDiffTable(item, base, head, { keys = null, linkify = false } = {}) {
  const cols = sideCols(item);
  const allKeys = keys || [...new Set([...Object.keys(base || {}), ...Object.keys(head || {})])];
  if (!allKeys.length) return el('p', { class: 'muted' }, 'none');
  const tbody = el('tbody');
  for (const k of allKeys) {
    const b = cellText(base?.[k]);
    const h = cellText(head?.[k]);
    const changed = item.status === 'modified' && b !== h;
    const cell = (v) => {
      const url = linkify && /^https?:\/\//i.test(v) ? safeUrl(v) : null;
      return el('td', { class: 'val' }, url ? el('a', { href: url }, v) : v || el('span', { class: 'muted' }, '—'));
    };
    tbody.append(el('tr', { class: changed ? 'changed' : null }, el('th', { scope: 'row' }, k), cols.map((c) => cell(c === 'base' ? b : h))));
  }
  return el('table', { class: 'kv' }, el('thead', {}, el('tr', {}, el('th', {}, ''), cols.map((c) => el('th', {}, c)))), tbody);
}

/**
 * Row-level diff of two lists keyed by `keyFn` (duplicate keys matched in order, e.g. several "SH" pads).
 * Returns rows {status: same|changed|added|removed, base, head, changedCols:Set}.
 */
export function diffRows(baseList, headList, keyFn, cols) {
  const keyed = (list) => {
    const seen = new Map();
    return (list || []).map((r) => {
      const k = keyFn(r);
      const n = seen.get(k) || 0;
      seen.set(k, n + 1);
      return [`${k}#${n}`, r];
    });
  };
  const b = keyed(baseList);
  const bm = new Map(b);
  const h = keyed(headList);
  const hm = new Map(h);
  const rows = [];
  for (const [k, hr] of h) {
    const br = bm.get(k);
    if (!br) { rows.push({ status: baseList ? 'added' : 'same', head: hr, changedCols: new Set() }); continue; }
    const changedCols = new Set(cols.filter((c) => cellText(c.get(br)) !== cellText(c.get(hr))).map((c) => c.name));
    rows.push({ status: changedCols.size ? 'changed' : 'same', base: br, head: hr, changedCols });
  }
  for (const [k, br] of b) if (!hm.has(k)) rows.push({ status: headList ? 'removed' : 'same', base: br, changedCols: new Set() });
  return rows;
}

function listDiffTable(title, baseList, headList, keyFn, cols) {
  const rows = diffRows(baseList, headList, keyFn, cols);
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const r of rows) if (r.status in counts) counts[r.status]++;
  const onlyChanges = el('input', { type: 'checkbox' });
  const tbody = el('tbody');
  const draw = () => {
    clear(tbody);
    for (const r of rows) {
      if (onlyChanges.checked && r.status === 'same') continue;
      const tr = el('tr', { class: `row-${r.status}` },
        el('td', { class: 'st' }, r.status === 'same' ? '' : r.status === 'added' ? '+' : r.status === 'removed' ? '−' : '~'));
      for (const c of cols) {
        const hv = r.head ? cellText(c.get(r.head)) : null;
        const bv = r.base ? cellText(c.get(r.base)) : null;
        const td = el('td', { class: r.changedCols.has(c.name) ? 'changed' : null });
        if (r.changedCols.has(c.name)) td.append(el('del', {}, bv), ' ', el('ins', {}, hv));
        else td.append(hv ?? bv ?? '');
        tr.append(td);
      }
      tbody.append(tr);
    }
  };
  onlyChanges.addEventListener('change', draw);
  draw();
  const summary = [counts.added && `${counts.added} added`, counts.removed && `${counts.removed} removed`, counts.changed && `${counts.changed} changed`].filter(Boolean).join(', ');
  return section(title,
    el('div', { class: 'table-tools' }, el('span', { class: 'muted' }, `${rows.length} rows${summary ? ` · ${summary}` : ''}`),
      (baseList && headList) ? el('label', {}, onlyChanges, ' only changes') : null),
    el('div', { class: 'scroll-x' }, el('table', { class: 'grid' },
      el('thead', {}, el('tr', {}, el('th', {}, ''), cols.map((c) => el('th', {}, c.name)))), tbody)));
}

const PAD_COLS = [
  { name: 'number', get: (p) => p.number },
  { name: 'type', get: (p) => p.type },
  { name: 'shape', get: (p) => p.shape },
  { name: 'x', get: (p) => p.at?.[0] ?? p.pos?.[0] ?? p.x },
  { name: 'y', get: (p) => p.at?.[1] ?? p.pos?.[1] ?? p.y },
  { name: 'rot', get: (p) => p.at?.[2] ?? p.angle ?? p.rotation ?? 0 },
  { name: 'w', get: (p) => p.size?.[0] ?? p.w },
  { name: 'h', get: (p) => p.size?.[1] ?? p.h },
  { name: 'drill', get: (p) => p.drill },
  { name: 'layers', get: (p) => p.layers },
];
const PIN_COLS = [
  { name: 'number', get: (p) => p.number },
  { name: 'name', get: (p) => p.name },
  { name: 'type', get: (p) => p.type },
  { name: 'unit', get: (p) => p.unit },
  { name: 'x', get: (p) => p.at?.[0] },
  { name: 'y', get: (p) => p.at?.[1] },
  { name: 'rot', get: (p) => p.at?.[2] },
  { name: 'length', get: (p) => p.length },
];

function scalarStats(s) {
  if (!s) return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') continue; // pads/pins lists get their own table
    out[k] = v;
  }
  return out;
}

export function renderDetails(item, manifest, container) {
  const headSha = manifest.head_sha;
  const baseSha = manifest.base_sha;
  const lr = item.line_range || {};
  const ghHead = item.status !== 'deleted' ? githubBlobUrl(manifest.repo, headSha, item.path, lr.head) : null;
  const ghBase = item.status !== 'added' ? githubBlobUrl(manifest.repo, baseSha, item.path, lr.base) : null;

  // file + links
  container.append(section('Source',
    el('div', { class: 'links' },
      el('code', { class: 'path' }, item.path || '?'),
      ghHead ? el('a', { class: 'btn small', href: ghHead }, 'View at head ↗') : null,
      ghBase ? el('a', { class: 'btn small', href: ghBase }, 'View at base ↗') : null,
      item.source?.head && assetUrl(item.source.head) ? el('a', { class: 'btn small', href: item.source.head, download: '' }, 'Download head') : null,
      item.source?.base && assetUrl(item.source.base) ? el('a', { class: 'btn small', href: item.source.base, download: '' }, 'Download base') : null)));

  // datasheet: prefer the self-contained copy (Addendum 1), then URL, then just name the repo path
  const ds = item.datasheet || {};
  const dsLinks = [];
  if (ds.file && assetUrl(ds.file)) dsLinks.push(el('a', { class: 'btn small', href: ds.file, target: '_blank', rel: 'noopener' }, 'Open PDF (copy in this report)'));
  if (ds.url && safeUrl(ds.url) && /^https?:/i.test(ds.url)) dsLinks.push(el('a', { class: 'btn small', href: ds.url }, `${new URL(ds.url).hostname} ↗`));
  if (ds.local) dsLinks.push(el('code', { class: 'path' }, ds.local));
  container.append(section('Datasheet', dsLinks.length ? el('div', { class: 'links' }, dsLinks) : el('p', { class: 'warn-text' }, 'No datasheet URL or local file found.')));

  // properties
  container.append(section('Properties', el('div', { class: 'scroll-x' },
    kvDiffTable(item, item.properties?.base, item.properties?.head, { linkify: true }))));

  // pads / pins
  const sb = item.stats?.base;
  const sh = item.stats?.head;
  if (item.kind === 'footprint' && (sb?.pads || sh?.pads)) {
    container.append(listDiffTable('Pads', sb?.pads || null, sh?.pads || null, (p) => String(p.number), PAD_COLS));
  }
  if (item.kind === 'symbol' && (sb?.pins || sh?.pins)) {
    container.append(listDiffTable('Pins', sb?.pins || null, sh?.pins || null, (p) => `${p.unit ?? ''}:${p.number}`, PIN_COLS));
  }
  if (sb || sh) {
    container.append(section('Statistics', el('div', { class: 'scroll-x' }, kvDiffTable(item, scalarStats(sb), scalarStats(sh)))));
  }

  // 3D models (per side when the manifest has model3d_by_side; Addendum 2)
  if (item.kind === 'footprint') {
    const bySide = item.model3d_by_side;
    const groups = bySide && (bySide.head || bySide.base)
      ? sideCols(item).map((sd) => [sd, bySide[sd] || []])
      : [[item.status === 'deleted' ? 'base' : 'head', item.model3d || []]];
    const xyz = (v) => (Array.isArray(v) ? v.map((n) => cellText(n)).join(', ') : '');
    const rows = [];
    for (const [sd, list] of groups) {
      for (const m of list) {
        if (!m) continue;
        rows.push(el('tr', { class: m.exists === false ? 'row-removed' : m.changed && item.status === 'modified' ? 'changed' : null },
          el('td', {}, sd),
          el('td', {}, el('code', { class: 'path' }, m.path_raw || ''), m.hide ? el('span', { class: 'muted' }, ' (hidden)') : null),
          el('td', {}, m.exists === true ? badge('ok', 'yes') : m.exists === false ? badge('verdict', 'fail', 'file missing') : '?'),
          el('td', { class: 'nowrap' }, xyz(m.offset)), el('td', { class: 'nowrap' }, xyz(m.rotate)), el('td', { class: 'nowrap' }, xyz(m.scale)),
          el('td', {}, m.file && assetUrl(m.file) ? el('a', { href: m.file, download: '' }, 'STEP') : '')));
      }
    }
    container.append(section('3D model files', rows.length
      ? el('div', { class: 'scroll-x' }, el('table', { class: 'grid' },
        el('thead', {}, el('tr', {}, ['side', 'path in footprint', 'exists', 'offset (mm)', 'rotate (°)', 'scale', 'file'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows)))
      : el('p', { class: 'warn-text' }, 'Footprint has no 3D model.')));
  }

  // warnings
  if (item.warnings?.length) {
    container.append(section('Render warnings', el('ul', { class: 'warnings' }, item.warnings.map((w) => el('li', {}, w)))));
  }

  // text diff
  if (item.text_diff) {
    const box = el('div', { class: 'diff-box' }, el('span', { class: 'muted' }, 'loading…'));
    container.append(section('Text diff', box));
    fetchText(item.text_diff)
      .then((txt) => { clear(box).append(renderPatch(txt, manifest, item)); })
      .catch((e) => { clear(box).append(el('span', { class: 'muted' }, `could not load diff: ${e.message}`)); });
  }
}

// --- unified diff with light s-expression highlighting ------------------------------------------------

const TOKEN_RE = /("(?:[^"\\]|\\.)*")|(\(\s*[A-Za-z_][\w.-]*)|(-?\d+(?:\.\d+)?)|(\)+)/g;

function highlight(line) {
  const out = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = m[1] ? 'tk-str' : m[2] ? 'tk-kw' : m[3] ? 'tk-num' : 'tk-par';
    out.push(el('span', { class: cls }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function renderPatch(text, manifest, item) {
  const lines = text.replace(/\n$/, '').split('\n');
  const MAX = 4000;
  const table = el('table', { class: 'patch' });
  const tb = el('tbody');
  table.append(tb);
  let oldNo = 0;
  let newNo = 0;
  for (const raw of lines.slice(0, MAX)) {
    let cls = 'ctx';
    let o = '';
    let n = '';
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      cls = 'hunk';
    } else if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      cls = 'meta';
    } else if (raw.startsWith('+')) {
      cls = 'add'; n = newNo++;
    } else if (raw.startsWith('-')) {
      cls = 'del'; o = oldNo++;
    } else if (raw.startsWith('\\')) {
      cls = 'meta';
    } else {
      o = oldNo++; n = newNo++;
    }
    const code = cls === 'meta' || cls === 'hunk' ? raw : [raw[0] || ' ', ...highlight(raw.slice(1))];
    tb.append(el('tr', { class: cls }, el('td', { class: 'ln' }, String(o)), el('td', { class: 'ln' }, String(n)), el('td', { class: 'code' }, code)));
  }
  const wrap = el('div', {}, table);
  if (lines.length > MAX) wrap.append(el('p', { class: 'muted' }, `… ${lines.length - MAX} more lines not shown.`));
  return wrap;
}
