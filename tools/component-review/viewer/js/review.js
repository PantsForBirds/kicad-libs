// Checks panel for one item (review.json is optional; everything here tolerates missing fields).
import { el, markdown, badge, githubBlobUrl, safeUrl, assetUrl } from './util.js';

const SEV_ORDER = { error: 0, warning: 1, info: 2 };

export function reviewFor(review, item) {
  return review?.items?.[item.id] || null;
}

export function findingCounts(r) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const f of r?.findings || []) if (f && f.severity in c) c[f.severity]++;
  return c;
}

export function renderReview(item, manifest, review, container) {
  const r = reviewFor(review, item);
  const head = el('div', { class: 'review-head' }, el('h3', {}, 'Checks'));
  container.append(head);
  if (!review) {
    container.append(el('p', { class: 'muted' }, 'No review.json in this report. The checks step did not run or failed.'));
    return;
  }
  if (!r) {
    container.append(el('p', { class: 'muted' }, 'This item was not checked.'));
    return;
  }
  const vb = badge('verdict', typeof r.verdict === 'string' ? r.verdict : null);
  if (vb) head.append(vb);
  container.append(markdown(r.summary));

  if (r.datasheet_used) {
    const ds = String(r.datasheet_used);
    const href = /^https?:/i.test(ds) ? safeUrl(ds) : assetUrl(ds);
    container.append(el('p', { class: 'small' }, 'Datasheet: ', href ? el('a', { href, target: '_blank', rel: 'noopener' }, ds) : el('code', {}, ds)));
  }

  const findings = sortFindings(r.findings);
  container.append(el('h4', {}, `Findings (${findings.length})`));
  if (!findings.length) container.append(el('p', { class: 'muted' }, 'No findings.'));
  container.append(renderFindings(findings, manifest, item));

  const checks = (r.checks || []).filter(Boolean);
  if (checks.length) {
    container.append(el('h4', {}, 'Rules checked'));
    container.append(el('table', { class: 'grid checks' },
      el('tbody', {}, checks.map((c) => el('tr', {},
        el('td', {}, badge('check', c.result)),
        el('td', {}, c.name || ''),
        el('td', { class: 'muted' }, c.detail || '')))),
    ));
  }
}

export function sortFindings(list) {
  return (Array.isArray(list) ? list : []).filter((f) => f && typeof f === 'object')
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
}

/** Findings list; item may be null for PR-level findings (they link to the head commit). */
export function renderFindings(findings, manifest, item) {
  const list = el('ol', { class: 'findings' });
  for (const f of findings) {
    // Deleted files only exist at base; everything else links to head.
    const deletedFile = item && item.status === 'deleted' && f.path === item.path;
    const sha = deletedFile ? manifest.base_sha : manifest.head_sha;
    const line = Number.isInteger(f.line) ? f.line : null;
    const path = typeof f.path === 'string' ? f.path : null;
    const link = path ? githubBlobUrl(manifest.repo, sha, path, line) : null;
    const sev = String(f.severity || 'info').replace(/\W/g, '');
    list.append(el('li', { class: `finding finding-${sev}` },
      el('div', { class: 'finding-head' },
        badge('sev', sev),
        f.category ? el('span', { class: 'cat' }, String(f.category)) : null,
        link ? el('a', { class: 'loc', href: link, title: `Open ${path} on GitHub` }, `${path.split('/').pop()}${line ? `:${line}` : ''} ↗`)
          : path ? el('code', { class: 'loc' }, path) : null),
      markdown(f.message),
      f.suggestion ? el('div', { class: 'suggestion' }, el('span', { class: 'muted' }, 'Suggestion: '), markdown(f.suggestion)) : null));
  }
  return list;
}

/** What produced review.json: `generator`, or `model` in files written by older runs. */
export function generatorOf(review) {
  for (const k of ['generator', 'model']) {
    const v = review?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}
