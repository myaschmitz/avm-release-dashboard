'use strict';

const STATE_LABEL = {
  'unreleased-work': 'Unreleased work',
  'never-released': 'No version tag',
  'automation-only': 'Bot commits only',
  'current': 'Fully released',
  'compare-failed': 'Lookup failed',
  'unknown': 'Unknown'
};

// Most actionable first. Drives the default table order.
const STATE_RANK = {
  'unreleased-work': 0,
  'never-released': 1,
  'compare-failed': 2,
  'automation-only': 3,
  'current': 4,
  'unknown': 5
};

const CARD_KEYS = ['unreleased-work', 'aged', 'never-released', 'nothing-to-release'];
const AGED_DAYS = 90;
const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

// Which series the trend chart draws, in legend order.
const SERIES = [
  { key: 'unreleasedWork', label: 'Unreleased work', color: 'var(--amber)' },
  { key: 'aged', label: 'Over ' + AGED_DAYS + ' days', color: 'var(--red)' },
  { key: 'awaitingIssues', label: 'Awaiting release', color: 'var(--accent)' }
];

let MODULES = [];
let HISTORY = [];
const EXPANDED = new Set();
let sortKey = 'state';
let sortAsc = true;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cell(label, className, text) {
  const td = el('td', className, text);
  td.dataset.label = label;
  return td;
}

function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toISOString().slice(0, 10);
}

function isAged(m) {
  return (m.oldestHumanDays || 0) > AGED_DAYS;
}

function isNothingPending(m) {
  return m.state === 'automation-only' || m.state === 'current';
}

/* theme ------------------------------------------------------------------ */

function applyTheme(choice) {
  document.documentElement.setAttribute('data-theme', choice);
  try { localStorage.setItem('avm-theme', choice); } catch (e) { /* private mode */ }

  document.getElementById('themeTriggerIcon').setAttribute('href', '#i-' + choice);
  document.getElementById('themeTriggerLabel').textContent = THEME_LABEL[choice] || choice;

  document.querySelectorAll('[data-theme-choice]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.themeChoice === choice));
  });
}

function closeThemeMenu() {
  document.getElementById('themeList').hidden = true;
  document.getElementById('themeTrigger').setAttribute('aria-expanded', 'false');
}

function wireTheme() {
  const trigger = document.getElementById('themeTrigger');
  const list = document.getElementById('themeList');

  let current = 'system';
  try { current = localStorage.getItem('avm-theme') || 'system'; } catch (e) { /* private mode */ }
  // An earlier build stored "auto" for this option.
  if (current === 'auto') current = 'system';
  applyTheme(current);

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const open = list.hidden;
    list.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  });

  list.querySelectorAll('[data-theme-choice]').forEach(b => {
    b.addEventListener('click', () => {
      applyTheme(b.dataset.themeChoice);
      closeThemeMenu();
      trigger.focus();
    });
  });

  document.addEventListener('click', e => {
    if (!document.getElementById('themeMenu').contains(e.target)) closeThemeMenu();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !list.hidden) { closeThemeMenu(); trigger.focus(); }
  });
}

/* trend chart ------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
}

// A viewBox lets the chart scale with the panel without recomputing on resize.
const CHART = { w: 900, h: 220, left: 40, right: 16, top: 16, bottom: 28 };

function renderTrend() {
  const panel = document.getElementById('trendPanel');
  const host = document.getElementById('trend');
  host.textContent = '';

  if (HISTORY.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const note = document.getElementById('trendNote');
  if (HISTORY.length === 1) {
    note.textContent = 'One day recorded so far. The shape appears once a few more runs land.';
  } else {
    note.textContent = HISTORY.length + ' days recorded, ' + HISTORY[0].date + ' to ' + HISTORY[HISTORY.length - 1].date + '.';
  }

  const plotW = CHART.w - CHART.left - CHART.right;
  const plotH = CHART.h - CHART.top - CHART.bottom;

  const values = HISTORY.flatMap(row => SERIES.map(s => row[s.key] || 0));
  // Round the ceiling up to a multiple of five so the gridline labels stay whole.
  const peak = Math.max(5, Math.ceil(Math.max(...values) / 5) * 5);

  const x = i => CHART.left + (HISTORY.length === 1 ? plotW / 2 : (i / (HISTORY.length - 1)) * plotW);
  const y = v => CHART.top + plotH - (v / peak) * plotH;

  const chart = svg('svg', {
    viewBox: `0 0 ${CHART.w} ${CHART.h}`,
    class: 'chart',
    role: 'img',
    'aria-label': 'Counts over time'
  });

  [0, 0.5, 1].forEach(fraction => {
    const value = Math.round(peak * fraction);
    const yy = y(value);
    chart.appendChild(svg('line', { x1: CHART.left, y1: yy, x2: CHART.w - CHART.right, y2: yy, class: 'grid' }));
    const label = svg('text', { x: CHART.left - 8, y: yy + 4, class: 'axis', 'text-anchor': 'end' });
    label.textContent = String(value);
    chart.appendChild(label);
  });

  SERIES.forEach(series => {
    const points = HISTORY.map((row, i) => `${x(i)},${y(row[series.key] || 0)}`).join(' ');
    if (HISTORY.length > 1) {
      chart.appendChild(svg('polyline', { points, class: 'line', stroke: series.color }));
    }
    HISTORY.forEach((row, i) => {
      const dot = svg('circle', { cx: x(i), cy: y(row[series.key] || 0), r: 3, class: 'dot', fill: series.color });
      const tip = svg('title');
      tip.textContent = `${row.date} — ${series.label}: ${row[series.key] || 0}`;
      dot.appendChild(tip);
      chart.appendChild(dot);
    });
  });

  const first = svg('text', { x: CHART.left, y: CHART.h - 8, class: 'axis' });
  first.textContent = HISTORY[0].date;
  chart.appendChild(first);

  if (HISTORY.length > 1) {
    const last = svg('text', { x: CHART.w - CHART.right, y: CHART.h - 8, class: 'axis', 'text-anchor': 'end' });
    last.textContent = HISTORY[HISTORY.length - 1].date;
    chart.appendChild(last);
  }

  host.appendChild(chart);

  const legend = document.getElementById('trendLegend');
  legend.textContent = '';
  SERIES.forEach(series => {
    const item = el('span', 'legend-item');
    const swatch = el('span', 'swatch');
    swatch.style.background = series.color;
    item.appendChild(swatch);
    item.appendChild(el('span', null, series.label));
    legend.appendChild(item);
  });
}

/* rendering -------------------------------------------------------------- */

function renderCards() {
  const counts = {};
  MODULES.forEach(m => { counts[m.state] = (counts[m.state] || 0) + 1; });

  const cards = [
    { key: 'unreleased-work', n: counts['unreleased-work'] || 0, label: 'modules with unreleased work', tone: 'warn' },
    { key: 'aged', n: MODULES.filter(isAged).length, label: 'unreleased over ' + AGED_DAYS + ' days', tone: 'alert' },
    { key: 'never-released', n: counts['never-released'] || 0, label: 'modules with no version tag', tone: '' },
    { key: 'nothing-to-release', n: MODULES.filter(isNothingPending).length, label: 'modules with nothing to release', tone: 'ok' }
  ];

  const host = document.getElementById('cards');
  host.textContent = '';

  cards.forEach(c => {
    const card = el('button', 'card' + (c.tone ? ' ' + c.tone : ''));
    card.type = 'button';
    card.appendChild(el('div', 'n', String(c.n)));
    card.appendChild(el('div', 'k', c.label));
    card.addEventListener('click', () => {
      const filter = document.getElementById('stateFilter');
      filter.value = filter.value === c.key ? '' : c.key;
      render();
    });
    host.appendChild(card);
  });
}

function compare(a, b) {
  let x, y;
  if (sortKey === 'state') {
    x = STATE_RANK[a.state] ?? 9;
    y = STATE_RANK[b.state] ?? 9;
  } else {
    x = a[sortKey];
    y = b[sortKey];
  }

  if (x === null || x === undefined) x = sortAsc ? Infinity : -Infinity;
  if (y === null || y === undefined) y = sortAsc ? Infinity : -Infinity;

  let result;
  if (typeof x === 'number' && typeof y === 'number') {
    result = x - y;
  } else {
    result = String(x).localeCompare(String(y));
  }
  if (result === 0) result = a.module.localeCompare(b.module);
  return sortAsc ? result : -result;
}

function matchesFilter(m, filter) {
  if (!filter) return true;
  if (filter === 'aged') return isAged(m);
  if (filter === 'nothing-to-release') return isNothingPending(m);
  return m.state === filter;
}

function linkItem(number, title, url, meta) {
  const li = el('li');
  const link = el('a', 'ref', '#' + number);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  li.appendChild(link);
  li.appendChild(el('span', 'ref-title', title));
  if (meta) li.appendChild(el('span', 'ref-meta', meta));
  return li;
}

function detailBlock(heading, items) {
  const block = el('div', 'detail-block');
  block.appendChild(el('h3', null, heading));
  const list = el('ul');
  items.forEach(node => list.appendChild(node));
  block.appendChild(list);
  return block;
}

function detailRow(m, prs, issues) {
  const row = el('tr', 'detail');
  const holder = el('td');
  holder.colSpan = 7;

  const box = el('div', 'detail-box');

  if (prs.length) {
    box.appendChild(detailBlock(
      prs.length + (prs.length === 1 ? ' pull request merged since ' : ' pull requests merged since ') + m.latestTag,
      prs.map(pr => linkItem(pr.number, pr.title, pr.url, pr.author ? '@' + pr.author : ''))
    ));
  }

  if (issues.length) {
    box.appendChild(detailBlock(
      issues.length + (issues.length === 1 ? ' issue awaiting a release' : ' issues awaiting a release'),
      issues.map(issue => linkItem(issue.number, issue.title, issue.url, ''))
    ));
  }

  if (prs.length) {
    // No tag is prefilled. Commit subjects do not reliably say whether a change is
    // breaking, so the version stays a human decision under SNFR17.
    const actions = el('div', 'detail-actions');
    const draft = el('a', 'button', 'Draft a release');
    draft.href = m.url + '/releases/new';
    draft.target = '_blank';
    draft.rel = 'noopener';
    actions.appendChild(draft);
    actions.appendChild(el('span', 'fine', 'Opens GitHub with the tag blank. Generate release notes there.'));
    box.appendChild(actions);
  }

  holder.appendChild(box);
  row.appendChild(holder);
  return row;
}

function render() {
  const term = document.getElementById('search').value.trim().toLowerCase();
  const state = document.getElementById('stateFilter').value;

  const shown = MODULES
    .filter(m => matchesFilter(m, state))
    .filter(m => !term || m.module.toLowerCase().includes(term))
    .sort(compare);

  const body = document.getElementById('rows');
  body.textContent = '';

  shown.forEach(m => {
    const tr = el('tr');

    const nameCell = cell('Module', 'cell-module');
    const link = el('a', null, m.module);
    link.href = m.url;
    link.target = '_blank';
    link.rel = 'noopener';
    nameCell.appendChild(link);
    tr.appendChild(nameCell);

    const stateCell = cell('State');
    stateCell.appendChild(el('span', 'pill ' + m.state, STATE_LABEL[m.state] || m.state));
    tr.appendChild(stateCell);

    tr.appendChild(cell('Version', m.latestTag ? null : 'dim', m.latestTag || 'none'));
    tr.appendChild(cell('Published', m.latestPublished ? null : 'dim', shortDate(m.latestPublished)));
    tr.appendChild(cell('Unreleased commits', 'num' + (m.humanAhead ? '' : ' dim'), String(m.humanAhead ?? 0)));

    const days = m.oldestHumanDays;
    tr.appendChild(cell('Oldest, days',
      'num' + (days ? (days > AGED_DAYS ? ' aged' : '') : ' dim'),
      days === null || days === undefined ? '—' : String(days)));

    tr.appendChild(cell('Managed files', m.pinnedVersion ? null : 'dim', m.pinnedVersion || 'none'));

    const prs = m.unreleasedPrs || [];
    const issues = m.awaitingReleaseIssues || [];
    const hasDetail = prs.length > 0 || issues.length > 0;

    if (hasDetail) {
      tr.classList.add('expandable');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-expanded', String(EXPANDED.has(m.repo)));
      nameCell.insertBefore(el('span', 'caret', '▸'), nameCell.firstChild);

      const toggle = () => {
        if (EXPANDED.has(m.repo)) { EXPANDED.delete(m.repo); } else { EXPANDED.add(m.repo); }
        render();
      };
      // The module name is a link out to GitHub, so clicking it must not also expand.
      tr.addEventListener('click', e => { if (!e.target.closest('a')) toggle(); });
      tr.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    }

    body.appendChild(tr);

    if (hasDetail && EXPANDED.has(m.repo)) {
      tr.classList.add('is-open');
      body.appendChild(detailRow(m, prs, issues));
    }
  });

  document.getElementById('empty').hidden = shown.length > 0;

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.classList.toggle('asc', th.dataset.sort === sortKey && sortAsc);
  });

  const active = document.getElementById('stateFilter').value;
  document.querySelectorAll('.card').forEach((card, i) => {
    card.classList.toggle('is-active', CARD_KEYS[i] === active);
  });
}

function wire() {
  document.getElementById('search').addEventListener('input', render);
  document.getElementById('stateFilter').addEventListener('change', render);
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (key === sortKey) { sortAsc = !sortAsc; } else { sortKey = key; sortAsc = true; }
      render();
    });
  });
}

wireTheme();

// History is optional. A repository publishing for the first time has no rows yet,
// and the page must still render everything else.
Promise.all([
  fetch('data/release-status.json').then(r => r.json()),
  fetch('data/history.json').then(r => (r.ok ? r.json() : [])).catch(() => [])
])
  .then(([doc, history]) => {
    MODULES = doc.modules || [];
    HISTORY = Array.isArray(history) ? history : [];
    document.getElementById('stamp').textContent = doc.generatedAt || 'unknown';
    document.getElementById('count').textContent = doc.repoCount ?? MODULES.length;
    renderCards();
    renderTrend();
    wire();
    render();
  })
  .catch(err => {
    document.getElementById('rows').innerHTML =
      '<tr><td colspan="7" class="dim">Could not load data/release-status.json — ' + err.message + '</td></tr>';
  });
