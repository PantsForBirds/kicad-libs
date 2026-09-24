// Component review viewer: loads manifest.json (+ optional review.json) from the same directory.
import { el, clear, append, fetchJson, githubUrl, shortSha, markdown, badge } from './util.js';
import { createView2D } from './view2d.js';
import { createPanel3D, has3d } from './panel3d.js';
import { renderDetails } from './details.js';
import { renderReview, reviewFor, findingCounts, renderFindings, sortFindings, generatorOf } from './review.js';

const $ = (sel) => document.querySelector(sel);
const KIND_LABEL = { footprint: 'Footprints', symbol: 'Symbols' };
const STATUS_ORDER = { added: 0, modified: 1, deleted: 2 };

const state = { manifest: null, review: null, items: [], filter: '', current: null, cleanups: [], tab: '2d' };

async function boot() {
  try {
    state.manifest = await fetchJson('manifest.json');
  } catch (e) {
    const fileHint = location.protocol === 'file:'
      ? 'Browsers block loading data from file:// pages and this copy has no `data.js`. Run `python3 serve.py` in this folder (or `python3 -m http.server`) and open the address it prints.'
      : `Could not load manifest.json (${e.message}).`;
    clear($('#main')).append(el('div', { class: 'fatal' }, el('h2', {}, 'No component review data'), markdown(fileHint)));
    return;
  }
  try { state.review = await fetchJson('review.json'); } catch { state.review = null; }
  const items = Array.isArray(state.manifest.items) ? state.manifest.items.filter((i) => i && i.slug) : [];
  state.items = items.sort((a, b) => (a.kind || '').localeCompare(b.kind || '')
    || (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || (a.library || '').localeCompare(b.library || '') || (a.name || '').localeCompare(b.name || ''));
  renderHeader();
  renderSidebar();
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  route();
}

// --- header -------------------------------------------------------------------------------------------

function renderHeader() {
  const m = state.manifest;
  const h = clear($('#header'));
  const prUrl = m.pr ? githubUrl(m.repo, 'pull', m.pr) : null;
  const commit = (sha) => (sha ? el('a', { href: githubUrl(m.repo, 'commit', sha), title: sha }, el('code', {}, shortSha(sha))) : '?');
  let when = '';
  if (m.generated_at) {
    const d = new Date(m.generated_at);
    when = Number.isNaN(+d) ? String(m.generated_at) : d.toLocaleString();
  }
  append(h, [
    el('a', { class: 'title', href: '#' }, 'Component review'),
    el('span', { class: 'hdr-item' }, prUrl ? el('a', { href: prUrl }, `${m.repo} #${m.pr}`) : el('span', {}, m.repo || '')),
    el('span', { class: 'hdr-item' }, commit(m.base_sha), ' → ', commit(m.head_sha)),
    el('span', { class: 'hdr-item muted' }, when ? `generated ${when}` : ''),
    m.kicad_version ? el('span', { class: 'hdr-item muted' }, `KiCad ${m.kicad_version}`) : null,
    el('span', { class: 'spacer' }),
    prFindingsChip(),
    el('span', { class: 'hdr-item muted' }, state.review ? `Checks: ${generatorOf(state.review) || 'deterministic'}` : 'no checks'),
  ]);
}

function prFindingsChip() {
  const n = sortFindings(state.review?.pr_findings).length;
  if (!n) return null;
  return el('a', { class: 'hdr-item chip', href: '#', title: 'PR-level findings (shown on the overview)' }, `${n} PR-level finding${n > 1 ? 's' : ''}`);
}

// --- sidebar ------------------------------------------------------------------------------------------

function renderSidebar() {
  const side = clear($('#sidebar'));
  const input = el('input', { type: 'search', placeholder: 'Filter (name, library, status, verdict)…', 'aria-label': 'Filter items', value: state.filter });
  input.addEventListener('input', () => { state.filter = input.value; renderList(); });
  const list = el('nav', { id: 'item-list', 'aria-label': 'Items' });
  side.append(el('div', { class: 'filter' }, input), list);
  renderList();
}

function matches(item, q) {
  if (!q) return true;
  const r = reviewFor(state.review, item);
  const hay = `${item.name} ${item.library} ${item.kind} ${item.status} ${r?.verdict || ''} ${item.path || ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}

function renderList() {
  const list = clear($('#item-list'));
  const groups = new Map();
  for (const it of state.items) {
    if (!matches(it, state.filter)) continue;
    if (!groups.has(it.kind)) groups.set(it.kind, []);
    groups.get(it.kind).push(it);
  }
  if (!groups.size) list.append(el('p', { class: 'muted pad' }, state.items.length ? 'No items match.' : 'The manifest has no items.'));
  for (const [kind, items] of groups) {
    list.append(el('h2', { class: 'group' }, `${KIND_LABEL[kind] || kind} `, el('span', { class: 'muted' }, `(${items.length})`)));
    const ul = el('ul');
    for (const it of items) {
      const r = reviewFor(state.review, it);
      const c = findingCounts(r);
      ul.append(el('li', {}, el('a', {
        href: `#${it.slug}`, class: `item-link${state.current?.slug === it.slug ? ' active' : ''}`, dataset: { slug: it.slug },
        'aria-current': state.current?.slug === it.slug ? 'page' : null,
      },
      el('span', { class: 'item-name', title: it.name }, it.name),
      el('span', { class: 'item-meta' },
        el('span', { class: 'lib', title: it.library }, it.library),
        badge('status', it.status),
        r ? badge('verdict', r.verdict, `${c.error} errors, ${c.warning} warnings`) : null))));
    }
    list.append(ul);
  }
}

// --- routing ------------------------------------------------------------------------------------------

function route() {
  const slug = decodeURIComponent(location.hash.replace(/^#/, ''));
  for (const fn of state.cleanups.splice(0)) fn();
  const item = state.items.find((i) => i.slug === slug);
  state.current = item || null;
  renderList();
  document.querySelector('.item-link.active')?.scrollIntoView({ block: 'nearest' });
  if (item) renderItem(item);
  else renderOverview(slug);
}

function onKey(e) {
  if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'j' || e.key === 'k') {
    const vis = state.items.filter((i) => matches(i, state.filter));
    const idx = vis.findIndex((i) => i.slug === state.current?.slug);
    const next = vis[Math.min(Math.max(idx + (e.key === 'j' ? 1 : -1), 0), vis.length - 1)];
    if (next) location.hash = next.slug;
  } else if (e.key === '/') {
    e.preventDefault();
    $('#sidebar input')?.focus();
  }
}

// --- overview -----------------------------------------------------------------------------------------

function renderOverview(unknownSlug) {
  const main = clear($('#main'));
  document.title = `Component review${state.manifest.pr ? ` · #${state.manifest.pr}` : ''}`;
  if (unknownSlug) main.append(el('div', { class: 'notice' }, `No item "${unknownSlug}" in this report; showing the overview.`));
  const counts = {};
  for (const it of state.items) counts[it.status] = (counts[it.status] || 0) + 1;
  main.append(el('h1', {}, 'Overview'),
    el('p', {}, `${state.items.length} items: `, Object.entries(counts).map(([s, n]) => [badge('status', s), ` ${n}  `])));
  if (state.review?.summary_markdown) {
    main.append(el('section', { class: 'card' }, el('h3', {}, 'Summary'), markdown(state.review.summary_markdown)));
  }
  const prf = sortFindings(state.review?.pr_findings);
  if (prf.length) {
    main.append(el('section', { class: 'card', id: 'pr-findings' }, el('h3', {}, `PR-level findings (${prf.length})`),
      renderFindings(prf, state.manifest, null)));
  }
  const rows = state.items.map((it) => {
    const r = reviewFor(state.review, it);
    const c = findingCounts(r);
    return el('tr', {},
      el('td', {}, el('a', { href: `#${it.slug}` }, it.name)),
      el('td', {}, it.library), el('td', {}, it.kind),
      el('td', {}, badge('status', it.status)),
      el('td', {}, r ? badge('verdict', r.verdict) : el('span', { class: 'muted' }, '—')),
      el('td', { class: 'num' }, r ? String(c.error) : ''), el('td', { class: 'num' }, r ? String(c.warning) : ''),
      el('td', { class: 'num' }, it.warnings?.length ? String(it.warnings.length) : ''));
  });
  main.append(el('section', { class: 'card' }, el('div', { class: 'scroll-x' }, el('table', { class: 'grid overview' },
    el('thead', {}, el('tr', {}, ['Item', 'Library', 'Kind', 'Status', 'Verdict', 'Errors', 'Warnings', 'Render warnings'].map((t) => el('th', {}, t)))),
    el('tbody', {}, rows)))));
}

// --- item page ----------------------------------------------------------------------------------------

function renderItem(item) {
  const main = clear($('#main'));
  main.scrollTop = 0;
  document.title = `${item.name} · Component review`;
  const r = reviewFor(state.review, item);

  const title = el('div', { class: 'item-title' },
    el('h1', {}, item.name),
    el('span', { class: 'muted' }, `${item.library} · ${item.kind}`),
    badge('status', item.status),
    r ? badge('verdict', r.verdict) : null,
    el('button', { class: 'btn small', title: 'Copy a link to this item', onclick: (e) => copyLink(e.currentTarget) }, 'Copy link'));

  // view tabs
  const tabs = [['2d', '2D']];
  if (item.kind === 'footprint' && has3d(item)) tabs.push(['3d', '3D']);
  if (!tabs.some(([t]) => t === state.tab)) state.tab = '2d';
  const tabBar = el('div', { class: 'tabs', role: 'tablist' });
  const viewBox = el('div', { class: 'view-box' });
  let viewCleanup = null;
  const showTab = (t) => {
    state.tab = t;
    viewCleanup?.();
    clear(viewBox);
    for (const b of tabBar.children) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    const v = t === '3d' ? createPanel3D(item, viewBox) : createView2D(item, viewBox);
    viewCleanup = () => v.destroy();
  };
  for (const [t, label] of tabs) tabBar.append(el('button', { class: 'tab', role: 'tab', dataset: { tab: t }, onclick: () => showTab(t) }, label));
  if (item.kind === 'footprint' && !has3d(item)) tabBar.append(el('span', { class: 'muted small' }, 'no 3D render for this item'));
  state.cleanups.push(() => viewCleanup?.());

  const details = el('div', { class: 'details' });
  const aside = el('aside', { class: 'review' });
  main.append(title, el('div', { class: 'item-grid' },
    el('div', { class: 'item-main' }, tabBar, viewBox, details),
    aside));
  showTab(state.tab);
  renderDetails(item, state.manifest, details);
  renderReview(item, state.manifest, state.review, aside);
}

function copyLink(btn) {
  const url = location.href;
  const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy link'; }, 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('Link', url));
  else prompt('Link', url);
}

boot();
