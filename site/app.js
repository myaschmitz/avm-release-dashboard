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

let MODULES = [];
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

    body.appendChild(tr);
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

fetch('data/release-status.json')
  .then(r => r.json())
  .then(doc => {
    MODULES = doc.modules || [];
    document.getElementById('stamp').textContent = doc.generatedAt || 'unknown';
    document.getElementById('count').textContent = doc.repoCount ?? MODULES.length;
    renderCards();
    wire();
    render();
  })
  .catch(err => {
    document.getElementById('rows').innerHTML =
      '<tr><td colspan="7" class="dim">Could not load data/release-status.json — ' + err.message + '</td></tr>';
  });
