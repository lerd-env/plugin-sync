const site = encodeURIComponent(lerd.context.site);
const $ = (id) => document.getElementById(id);
const form = $('form');
let config = { environments: {}, local: {} };
let current = null; // the environment shown
let dir = '';
const picked = { local: new Set(), remote: new Set() };
const health = {}; // env name -> { state: ok|bad|busy, database, error }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function size(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do (n /= 1024), i++; while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

function when(t) {
  const d = new Date(t * 1000);
  const days = (Date.now() - d) / 864e5;
  return days < 1 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

function busy(on) {
  for (const b of document.querySelectorAll('button')) b.disabled = on;
  if (!on) renderSelection();
}

async function api(path, body) {
  const opts = body ? { method: 'POST', body } : undefined;
  return JSON.parse(await lerd.api(path + (path.includes('?') ? '&' : '?') + 'site=' + site, opts));
}

function showLog(what, result) {
  $('out').hidden = false;
  $('out-what').textContent = what;
  $('log').textContent = result.log || '(no output)';
  $('out-pill').className = 'lerd-pill ' + (result.ok ? 'ok' : 'bad');
  $('out-pill').textContent = result.ok ? 'done' : 'failed';
  $('out').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- environments ----

function renderEnvs() {
  const names = Object.keys(config.environments);
  const cards = names.map((n) => {
    const env = config.environments[n];
    const h = health[n] || {};
    const label = { ok: 'Connected', bad: 'Unreachable', busy: 'Checking' }[h.state] || 'Not checked';
    return el(
      'div',
      { class: 'lerd-card env', role: 'button', tabindex: '0', 'aria-current': String(n === current), onclick: () => select(n), onkeydown: (e) => e.key === 'Enter' && select(n) },
      el('span', { class: 'tile' }, icon('server')),
      el('span', { class: 'meta' }, el('span', { class: 'name' }, n), el('span', { class: 'host lerd-mono lerd-muted', title: `${env.ssh}:${env.path}` }, env.ssh), el('span', { class: 'dot ' + (h.state || ''), title: h.error || '' }, label)),
      el('button', { class: 'gear', title: `${n} settings`, 'aria-label': `${n} settings`, onclick: (e) => (e.stopPropagation(), openSettings(n)) }, icon('gear')),
    );
  });
  cards.push(el('button', { class: 'lerd-card env add', onclick: () => openSettings(null) }, icon('plus'), 'Add environment'));
  $('envs').replaceChildren(...cards);
  $('no-env').hidden = names.length > 0;
  $('main').hidden = !current;
}

async function select(name) {
  if (current === name) return;
  current = name;
  dir = '';
  picked.local.clear();
  picked.remote.clear();
  renderEnvs();
  renderDb();
  await Promise.all([load(), check(name), loadBackups(), loadScrub()]);
}

async function check(name) {
  if (health[name]?.state === 'ok') return;
  health[name] = { state: 'busy' };
  renderEnvs();
  try {
    const r = await api('run', { action: 'test', env: name });
    health[name] = r.ok ? { state: 'ok', database: r.database } : { state: 'bad', error: r.log };
  } catch (e) {
    health[name] = { state: 'bad', error: e.message };
  }
  renderEnvs();
  renderDb();
}

// ---- files ----

// Both sides' listings, keyed by project-relative folder, filled in as folders
// open. Picks and open folders survive reloads so a tree can be built up.
let tree = { local: {}, remote: {}, status: {} };
let remoteError = '';
const expanded = new Set();
const loading = new Set();

function merge(res) {
  for (const side of ['local', 'remote', 'status']) Object.assign(tree[side], res[side] || {});
  remoteError = res.remote_error || '';
}

async function fetchDir(d, all = false) {
  const res = await api(`ls?env=${encodeURIComponent(current)}&dir=${encodeURIComponent(d)}${all ? '&all=1' : ''}`);
  if (res.error) throw new Error(res.error);
  return res;
}

// Starts over at the top folder, keeping nothing from another environment.
async function load() {
  tree = { local: {}, remote: {}, status: {} };
  expanded.clear();
  await refresh();
}

// Reloads the top folder and every open one, as they are now on both sides.
async function refresh() {
  const dirs = [dir, ...[...expanded].filter((d) => d.startsWith(dir ? dir + '/' : ''))];
  for (const d of dirs) loading.add(d);
  renderFiles();
  const results = await Promise.all(dirs.map((d) => fetchDir(d).catch((e) => ({ remote_error: e.message }))));
  tree = { local: {}, remote: {}, status: {} };
  results.forEach(merge);
  loading.clear();
  renderFiles();
}

async function toggle(rel) {
  if (expanded.delete(rel)) return renderFiles();
  expanded.add(rel);
  if (rel in tree.local || rel in tree.remote) return renderFiles();
  loading.add(rel);
  renderFiles();
  try {
    merge(await fetchDir(rel));
  } catch (e) {
    remoteError = e.message;
  }
  loading.delete(rel);
  renderFiles();
}

async function expandAll() {
  busy(true);
  $('status').textContent = 'Listing everything…';
  try {
    const res = await fetchDir(dir, true);
    merge(res);
    for (const side of ['local', 'remote']) for (const d of Object.keys(res[side] || {})) if (d !== dir) expanded.add(d);
  } catch (e) {
    await confirmDialog('Too much to expand', e.message, 'Close', { info: true });
  } finally {
    $('status').textContent = '';
    busy(false);
    renderFiles();
  }
}

function collapseAll() {
  for (const d of [...expanded]) if (!dir || d.startsWith(dir + '/')) expanded.delete(d);
  renderFiles();
}

function open(next) {
  dir = next;
  refresh();
}

function renderCrumbs() {
  const parts = dir ? dir.split('/') : [];
  const nodes = [el('button', { onclick: () => open('') }, 'project')];
  parts.forEach((p, i) => nodes.push(el('span', { class: 'sep' }, '/'), el('button', { onclick: () => open(parts.slice(0, i + 1).join('/')) }, p)));
  $('crumbs').replaceChildren(...nodes);
}

const BADGE = {
  local: { local: ['accent', 'only here'], changed: ['warn', 'differs'], same: ['faint', 'same'] },
  remote: { remote: ['accent', 'only here'], changed: ['warn', 'differs'], same: ['faint', 'same'] },
};

// The picked folder a path sits inside, if any: it goes with that folder.
function pickedParent(side, rel) {
  return [...picked[side]].find((p) => rel.startsWith(p + '/'));
}

// A picked folder already holds everything under it, so its picks inside go.
function pick(side, rel, on) {
  if (!on) return picked[side].delete(rel);
  for (const p of [...picked[side]]) if (p.startsWith(rel + '/')) picked[side].delete(p);
  picked[side].add(rel);
}

// On a file, "differs" opens lerd's diff, server on the left and this site on
// the right; "only here" and the faint "same" open that side's copy in lerd's viewer.
function badgeEl([kind, text], rel, entry, side) {
  if (entry.type === 'dir') return el('span', { class: 'lerd-pill ' + kind }, text);
  // lerd before 1.39 ignores lerd.diff and lerd.view, so there is nothing to click.
  if (!config.local?.viewer) return el('span', { class: 'lerd-pill ' + kind, title: 'Showing files needs lerd 1.39 or newer' }, text);
  const show = text === 'differs' ? () => showDiff(rel) : () => showOne(rel, side, text === 'same');
  return el('button', { class: 'lerd-pill ' + kind + ' pill-btn', title: text === 'differs' ? 'Show the difference' : 'Show the file', onclick: (e) => (e.stopPropagation(), show()) }, text);
}

async function showOne(rel, side, same = false) {
  let res;
  try {
    res = await api(`file?env=${encodeURIComponent(current)}&side=${side}&file=${encodeURIComponent(rel)}`);
  } catch (e) {
    res = { error: e.message };
  }
  if (res.error) return confirmDialog(rel, res.error, 'Close', { info: true });
  const label = same ? `Same size on this site and ${current}` : side === 'local' ? `This site, not on ${current}` : `${current}, not on this site`;
  lerd.view({ path: rel, content: res[side], label });
}

async function showDiff(rel) {
  let res;
  try {
    res = await api(`file?env=${encodeURIComponent(current)}&file=${encodeURIComponent(rel)}`);
  } catch (e) {
    res = { error: e.message };
  }
  if (res.error) return confirmDialog(`${rel} differs`, res.error, 'Close', { info: true });
  lerd.diff({ path: rel, original: res.remote, modified: res.local, before: current, after: 'This site' });
}

function row(side, parentDir, entry, depth) {
  const rel = parentDir ? `${parentDir}/${entry.name}` : entry.name;
  const isDir = entry.type === 'dir';
  const open = isDir && expanded.has(rel);
  const locked = !!entry.locked;
  const parent = pickedParent(side, rel);
  const title = parent ? `included with ${parent}/` : undefined;
  const box = el('input', { type: 'checkbox', 'aria-label': entry.name, disabled: locked || !!parent, title });
  box.checked = !locked && (!!parent || picked[side].has(rel));
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    pick(side, rel, box.checked);
    renderFiles();
  });
  const badge = BADGE[side][tree.status[parentDir]?.[entry.name]];
  const caret = isDir ? el('span', { class: 'caret' + (open ? ' open' : '') }, icon('chevron')) : el('span');
  return el(
    'div',
    {
      class: `f${isDir ? ' dir' : ''}${locked ? ' locked' : ''}`,
      style: `--depth:${depth}`,
      'aria-expanded': isDir ? String(open) : undefined,
      title: isDir ? 'Expand or collapse' : undefined,
      onclick: isDir ? () => toggle(rel) : undefined,
    },
    caret,
    // Each side keeps its own config, so it gets a lock that says why instead of a box.
    locked ? el('span', { class: 'lock', title: `${entry.name} is never synced: each side keeps its own config, lerd setup and repository, plus what this environment's settings add` }, icon('lock')) : box,
    icon(isDir ? 'folder' : 'file'),
    el('span', { class: 'n', title: entry.name }, entry.name),
    badge ? badgeEl(badge, rel, entry, side) : el('span'),
    el('span', { class: 'num' }, isDir ? el('button', { class: 'focus', title: `Show only ${entry.name}`, 'aria-label': `Show only ${entry.name}`, onclick: (e) => (e.stopPropagation(), openFolder(rel)) }, icon('enter')) : size(entry.size)),
    el('span', { class: 'num' }, when(entry.mtime)),
  );
}

function openFolder(rel) {
  expanded.delete(rel);
  open(rel);
}

// The rows under one folder, open folders followed by their own rows.
// Both sides' entries of one folder by name, folders first, so the two panes
// draw the same rows in the same order and scroll together line for line.
function merged(d) {
  const byName = new Map();
  for (const side of ['local', 'remote']) for (const e of tree[side][d] || []) byName.set(e.name, { ...byName.get(e.name), [side]: e });
  const type = (m) => (m.local || m.remote).type;
  return [...byName.entries()].sort(([a, x], [b, y]) => (type(x) === type(y) ? a.localeCompare(b) : type(x) === 'dir' ? -1 : 1));
}

function note(depth, text) {
  return el('div', { class: 'f note', style: `--depth:${depth}` }, el('span'), el('span', { class: 'lerd-muted' }, text));
}

// With sync scroll on, a side that lacks a name gets an empty row of the same
// height in its place so the panes line up; with it off each side shows only
// what it has.
function rows(side, d, depth) {
  const out = [];
  for (const [name, both] of merged(d)) {
    const entry = both[side];
    if (!entry && !syncScroll) continue;
    out.push(entry ? row(side, d, entry, depth) : el('div', { class: 'f ghost', style: `--depth:${depth}`, 'aria-hidden': 'true' }));
    const rel = d ? `${d}/${name}` : name;
    if ((entry || both.local || both.remote).type !== 'dir' || !expanded.has(rel)) continue;
    if (loading.has(rel)) out.push(note(depth + 1, 'Loading…'));
    else if (!merged(rel).length) out.push(note(depth + 1, 'empty'));
    else out.push(...rows(side, rel, depth + 1));
  }
  return out;
}

function pane(side) {
  const env = config.environments[current] || {};
  const head = side === 'local'
    ? [icon('laptop'), 'This site', config.local?.path || lerd.context.domain]
    : [icon('server'), current, `${env.ssh}:${env.path}`];
  const all = el('input', { type: 'checkbox', 'aria-label': 'Pick everything here' });
  const header = el('div', { class: 'pane-head' }, all, el('span', { class: 'meta' }, el('span', { class: 'title' }, head[1]), el('span', { class: 'where lerd-mono lerd-muted', title: head[2] }, head[2])), el('span', { class: 'tile' }, head[0]));
  const top = tree[side][dir];
  all.disabled = true;
  if (loading.has(dir) && !top) return [header, el('div', { class: 'lerd-empty' }, el('span', { class: 'lerd-muted' }, 'Loading…'))];
  if (side === 'remote' && remoteError && !top) return [header, el('div', { class: 'lerd-empty' }, el('strong', {}, 'Could not list the server'), el('span', { class: 'lerd-mono' }, remoteError))];
  const up = dir ? el('div', { class: 'f dir', style: '--depth:0', title: 'Up a folder', onclick: () => open(dir.split('/').slice(0, -1).join('/')) }, el('span'), el('span'), icon('folder'), el('span', { class: 'n' }, '..'), el('span'), el('span'), el('span')) : null;
  const body = (syncScroll ? merged(dir) : top || []).length || up
    ? el('div', { class: 'rows' }, up, ...rows(side, dir, 0))
    : el('div', { class: 'lerd-empty' }, el('span', { class: 'lerd-muted' }, side === 'local' ? 'This folder is empty or missing here' : 'This folder is empty or missing on the server'));
  const pickable = (top || []).filter((e) => !e.locked).map((e) => (dir ? `${dir}/${e.name}` : e.name));
  const inside = dir && pickedParent(side, dir + '/x');
  all.checked = !!inside || (pickable.length > 0 && pickable.every((p) => picked[side].has(p)));
  all.disabled = !!inside || !pickable.length;
  all.addEventListener('change', () => {
    for (const p of pickable) pick(side, p, all.checked);
    renderFiles();
  });
  return [header, body];
}

// Scrolling both panes together is opt in. It is not remembered: the frame is
// sandboxed with no origin of its own, so the browser gives it no storage.
let syncScroll = false;

// Redrawing replaces the rows, so each pane's scroll is carried over; with
// sync on, the panes follow each other, which works since their rows line up.
function renderFiles() {
  const scroll = { local: document.querySelector('#pane-local .rows')?.scrollTop || 0, remote: document.querySelector('#pane-remote .rows')?.scrollTop || 0 };
  renderCrumbs();
  $('pane-local').replaceChildren(...pane('local'));
  $('pane-remote').replaceChildren(...pane('remote'));
  const lists = [...document.querySelectorAll('.pane .rows')];
  for (const list of lists) {
    list.scrollTop = scroll[list.parentElement.id.replace('pane-', '')];
    list.addEventListener('scroll', () => {
      if (!syncScroll) return;
      for (const other of lists) if (other !== list && other.scrollTop !== list.scrollTop) other.scrollTop = list.scrollTop;
    });
  }
  renderSelection();
}

// Files each side's picks hold, folders counted through, asked of that side.
const counts = { local: 0, remote: 0 };
let countSeq = 0;
const files = (n) => `${n} file${n === 1 ? '' : 's'}`;

function renderSelection() {
  const seq = ++countSeq;
  for (const side of ['local', 'remote']) {
    counts[side] = picked[side].size ? null : 0;
    if (!picked[side].size) continue;
    api(`count?env=${encodeURIComponent(current)}&side=${side}&count=1&paths=${encodeURIComponent(JSON.stringify([...picked[side]]))}`)
      .then((r) => r.files)
      .catch(() => 0)
      .then((n) => {
        if (seq !== countSeq) return;
        counts[side] = n;
        renderButtons();
      });
  }
  renderButtons();
}

function renderButtons() {
  const label = (side, verb) => (!picked[side].size ? verb : counts[side] === null ? `${verb} …` : `${verb} ${files(counts[side])}`);
  $('push-label').textContent = label('local', 'Push');
  $('pull-label').textContent = label('remote', 'Pull');
  $('push-sel').disabled = !counts.local;
  $('pull-sel').disabled = !counts.remote;
  const n = picked.local.size + picked.remote.size;
  $('picked').hidden = !n;
  $('picked-n').textContent = `${n} picked`;
}

async function transfer(direction) {
  const side = direction === 'push' ? 'local' : 'remote';
  const paths = [...picked[side]];
  const ok = await confirmDialog(
    direction === 'push' ? `Push ${files(counts[side])} to ${current}?` : `Pull ${files(counts[side])} from ${current}?`,
    direction === 'push'
      ? 'These are copied to the server, replacing what is there under the same name. Nothing on the server is deleted.'
      : 'These are copied into this site, replacing local files under the same name. Nothing here is deleted.',
    direction === 'push' ? 'Push' : 'Pull',
    { list: paths },
  );
  if (!ok) return;
  busy(true);
  try {
    const res = await api('run', { action: 'transfer', direction, env: current, paths });
    showLog(`${direction} ${files(counts[side])}`, res);
    if (res.ok) picked[side].clear();
  } catch (e) {
    showLog(direction, { ok: false, log: e.message });
  } finally {
    busy(false);
  }
  refresh();
  loadBackups();
}

// ---- database ----

function renderDb() {
  if (!current) return;
  const env = config.environments[current];
  const remoteDb = health[current]?.database || 'the server database';
  $('db-title').textContent = `${config.local?.database || 'This site'} ⇄ ${remoteDb} on ${current}`;
  $('db-sub').textContent = env.url && config.local?.url
    ? `Addresses rewritten both ways: ${config.local.url} ⇄ ${env.url}`
    : 'A pull takes a local snapshot first; a push backs the server up first.';
}

async function runDb(direction) {
  let body = { action: direction, env: current, what: 'db' };
  if (direction === 'pull') {
    const ok = await confirmDialog(`Pull the ${current} database?`, "This site's local database is replaced. A before-sync-pull snapshot is taken first, which lerd db:restore brings back.", 'Pull database');
    if (!ok) return;
  } else {
    const typed = await confirmDialog(`Replace the ${current} database?`, `The server's database is overwritten with this site's. It is backed up on the server first. Type ${current} to go on.`, 'Push database', { typed: current });
    if (!typed) return;
    body.confirm = typed;
  }
  busy(true);
  try {
    showLog(`${direction} database`, await api('run', body));
  } catch (e) {
    showLog(`${direction} database`, { ok: false, log: e.message });
  } finally {
    busy(false);
  }
  loadBackups();
}

// ---- backups ----

let kept = null; // { items, snapshots, errors, local_database }
let backupTab = 'files';
const openBackup = new Map(); // backup id -> its files, once listed

// Backups are stamped in UTC, like 20261111T104156.
function stampDate(s) {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)));
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function loadBackups() {
  if (!current) return;
  kept = null;
  openBackup.clear();
  renderBackups();
  try {
    kept = await api(`backups?env=${encodeURIComponent(current)}&backups=1`);
  } catch (e) {
    kept = { items: [], snapshots: [], errors: [e.message] };
  }
  renderBackups();
}

function backupRow({ icon: ic, title, meta, actions, id }) {
  const rowEl = el('div', { class: 'bk' }, el('span', { class: 'tile' }, icon(ic)), el('span', { class: 'meta' }, el('span', { class: 'title' }, title), el('span', { class: 'lerd-muted' }, meta)), ...actions);
  if (!id || !openBackup.has(id)) return [rowEl];
  const files = openBackup.get(id);
  const list = files === null
    ? el('div', { class: 'bk-file' }, el('span', { class: 'lerd-muted' }, 'Loading…'))
    : files.map((f) => el('div', { class: 'bk-file' }, el('span', { class: 'p lerd-mono', title: f.path }, f.path), el('span', { class: 'num' }, size(f.size)), (config.local?.viewer ? el('button', { class: 'lerd-pill pill-btn', onclick: () => viewKept(id, f.path) }, 'view') : el('span'))));
  return [rowEl, el('div', { class: 'bk-files' }, ...[].concat(list))];
}

function fileBackupRows() {
  return kept.items.filter((b) => b.kind !== 'db').map((b) => backupRow({
    id: b.id,
    icon: b.kind === 'push' ? 'server' : 'laptop',
    title: b.kind === 'push' ? `Replaced on ${current} by a push` : 'Replaced on this site by a pull',
    meta: `${stampDate(b.stamp)} · ${b.files} file${b.files === 1 ? '' : 's'} · ${size(b.bytes)}`,
    actions: [
      el('button', { onclick: () => toggleBackup(b.id) }, openBackup.has(b.id) ? 'Hide files' : 'Files'),
      el('button', { onclick: () => restoreBackup(b) }, 'Restore'),
      removeButton(b),
    ],
  })).flat();
}

function dbBackupRows() {
  const server = kept.items.filter((b) => b.kind === 'db').map((b) => backupRow({
    icon: 'server',
    title: `${current} database, before a push`,
    meta: `${stampDate(b.stamp)} · ${size(b.bytes)} · kept on the server`,
    actions: [el('button', { class: 'danger', onclick: () => restoreBackup(b) }, 'Restore'), removeButton(b)],
  }));
  const local = kept.snapshots.map((s) => backupRow({
    icon: 'laptop',
    title: `Snapshot ${s.name}`,
    meta: `${s.created} · ${s.size} · ${kept.local_database || 'this site'} in lerd`,
    actions: [el('button', { onclick: () => restoreBackup(s) }, 'Restore'), removeButton(s)],
  }));
  return [...server, ...local].flat();
}

function renderBackups() {
  for (const b of document.querySelectorAll('#backup-tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === backupTab));
  if (!kept) return $('backups').replaceChildren(el('div', { class: 'lerd-empty' }, el('span', { class: 'lerd-muted' }, 'Loading…')));
  const rows = backupTab === 'files' ? fileBackupRows() : dbBackupRows();
  $('backups').replaceChildren(...(rows.length ? rows : [el('div', { class: 'lerd-empty' }, el('span', { class: 'lerd-muted' }, backupTab === 'files' ? 'Nothing kept yet. A push or pull keeps every file it replaces here.' : 'No database backups or snapshots yet.'))]));
  const hint = backupTab === 'files'
    ? `Keeps the newest ${config.environments[current]?.keep || 10} of each side${config.environments[current]?.backup === false ? '; backups are off for this environment' : ''}. Change it in the environment's settings.`
    : 'Server backups are taken before every database push; local snapshots are lerd\'s, taken before every pull.';
  $('backups-hint').textContent = [hint, ...(kept.errors || [])].join(' ');
}

async function toggleBackup(id) {
  if (openBackup.has(id)) {
    openBackup.delete(id);
    return renderBackups();
  }
  openBackup.set(id, null);
  renderBackups();
  try {
    openBackup.set(id, (await api(`backups?env=${encodeURIComponent(current)}&backups=1&id=${encodeURIComponent(id)}`)).files);
  } catch (e) {
    openBackup.delete(id);
    showLog('backup files', { ok: false, log: e.message });
  }
  renderBackups();
}

async function viewKept(id, rel) {
  const res = await api(`file?env=${encodeURIComponent(current)}&backup=${encodeURIComponent(id)}&file=${encodeURIComponent(rel)}`).catch((e) => ({ error: e.message }));
  if (res.error) return confirmDialog(rel, res.error, 'Close', { info: true });
  const b = kept.items.find((x) => x.id === id);
  lerd.view({ path: rel, content: res.backup, label: `Kept ${stampDate(b.stamp)}, ${b.kind === 'push' ? `on ${current}` : 'on this site'}` });
}

function removeButton(b) {
  return el('button', { class: 'danger icon-btn', title: 'Remove this backup', 'aria-label': 'Remove this backup', onclick: () => removeBackup(b) }, icon('trash'));
}

async function removeBackup(b) {
  const what = b.kind === 'snapshot' ? `snapshot ${b.name}` : b.kind === 'db' ? `the ${current} database backup from ${stampDate(b.stamp)}` : `the backup from ${stampDate(b.stamp)}`;
  const where = b.kind === 'snapshot' || b.kind === 'pull' ? 'from this machine' : `from ${current}`;
  if (!(await confirmDialog(`Remove ${what}?`, `It is deleted ${where} for good and cannot be restored afterwards.`, 'Remove', { danger: true }))) return;
  busy(true);
  try {
    const res = await api('run', { action: 'remove-backup', env: current, id: b.id });
    if (!res.ok) showLog('remove backup', res);
  } catch (e) {
    showLog('remove backup', { ok: false, log: e.message });
  } finally {
    busy(false);
  }
  loadBackups();
}

async function restoreBackup(b) {
  const body = { action: 'restore', env: current, id: b.id };
  if (b.kind === 'db') {
    const typed = await confirmDialog(`Restore the ${current} database?`, `The server's database goes back to how it was on ${stampDate(b.stamp)}. It is backed up again first. Type ${current} to go on.`, 'Restore database', { typed: current });
    if (!typed) return;
    body.confirm = typed;
  } else if (b.kind === 'snapshot') {
    if (!(await confirmDialog(`Restore ${b.name}?`, "This site's local database goes back to that snapshot.", 'Restore snapshot'))) return;
  } else {
    const where = b.kind === 'push' ? `on ${current}` : 'on this site';
    if (!(await confirmDialog(`Restore ${b.files} file${b.files === 1 ? '' : 's'} ${where}?`, `They go back to how they were on ${stampDate(b.stamp)}. What they replace is kept as a new backup first.`, 'Restore'))) return;
  }
  busy(true);
  try {
    showLog(`restore ${b.kind === 'snapshot' ? b.name : stampDate(b.stamp)}`, await api('run', body));
  } catch (e) {
    showLog('restore', { ok: false, log: e.message });
  } finally {
    busy(false);
  }
  loadBackups();
  if (b.kind === 'push' || b.kind === 'pull') refresh();
}

for (const b of document.querySelectorAll('#backup-tabs button')) b.addEventListener('click', () => ((backupTab = b.dataset.tab), renderBackups()));
$('backups-refresh').addEventListener('click', () => loadBackups());

// ---- scrub ----

let scrubState = null;

async function loadScrub() {
  if (!current) return;
  try {
    scrubState = await api(`scrub?env=${encodeURIComponent(current)}&scrub=1`);
  } catch (e) {
    scrubState = null;
  }
  renderScrub();
}

function renderScrub() {
  const on = !!scrubState?.enabled;
  $('scrub-on').checked = on;
  // Shared by every environment of the site, or one only this environment runs.
  $('scrub-file').replaceChildren(
    el('option', { value: 'shared' }, '.lerd/scrub.sql, shared'),
    el('option', { value: 'own' }, `.lerd/scrub-${current}.sql, only ${current}`),
  );
  $('scrub-file').value = scrubState?.own ? 'own' : 'shared';
  $('scrub-file').hidden = $('scrub-view').hidden = $('scrub-edit').hidden = !on;
}

async function setScrub(on) {
  try {
    scrubState = await api('run', { action: on ? 'scrub-on' : 'scrub-off', env: current });
  } catch (e) {
    showLog('scrub', { ok: false, log: e.message });
  }
  renderScrub();
}

// The plugin's own editor, for a lerd that has no lerd.edit.
function textEditor(title, text) {
  $('editor-title').textContent = title;
  $('editor-text').value = text;
  $('editor').showModal();
  return new Promise((resolve) => {
    const done = (v) => {
      $('editor').close();
      $('editor-save').onclick = $('editor-cancel').onclick = $('editor').oncancel = null;
      resolve(v);
    };
    $('editor-save').onclick = () => done($('editor-text').value);
    $('editor-cancel').onclick = () => done(null);
    $('editor').oncancel = () => done(null);
  });
}

async function editScrub() {
  const label = `Runs on this site's database after every pull from ${current}`;
  let text;
  try {
    text = await lerd.edit({ path: scrubState.path, content: scrubState.content, label });
  } catch {
    text = await textEditor(scrubState.path, scrubState.content);
  }
  if (text === null || text === scrubState.content) return;
  try {
    scrubState = await api('run', { action: 'scrub-save', env: current, content: text });
    renderScrub();
  } catch (e) {
    showLog('scrub', { ok: false, log: e.message });
  }
}

function viewScrub() {
  const label = `Runs on this site's database after every pull from ${current}`;
  if (config.local?.viewer) return lerd.view({ path: scrubState.path, content: scrubState.content, label });
  confirmDialog(scrubState.path, scrubState.content || '(empty)', 'Close', { info: true });
}

$('scrub-on').addEventListener('change', (e) => setScrub(e.target.checked));
$('scrub-file').addEventListener('change', async (e) => {
  try {
    scrubState = await api('run', { action: 'scrub-file', env: current, file: e.target.value });
  } catch (err) {
    showLog('scrub', { ok: false, log: err.message });
  }
  renderScrub();
});
$('scrub-edit').addEventListener('click', () => editScrub());
$('scrub-view').addEventListener('click', () => viewScrub());

// ---- dialogs ----

// Asks in lerd's own dialog. With typed set, the yes button only works once
// that word is typed, for what cannot be undone from here.
function confirmDialog(title, body, yes, { typed, list, info, danger } = {}) {
  $('confirm-no').hidden = !!info;
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-yes').textContent = yes;
  $('confirm-yes').className = typed || danger ? 'danger' : 'primary';
  $('confirm-list').hidden = !list;
  if (list) $('confirm-list').replaceChildren(...list.slice(0, 12).map((p) => el('li', {}, p)), ...(list.length > 12 ? [el('li', {}, `and ${list.length - 12} more`)] : []));
  const input = $('confirm-type');
  input.hidden = !typed;
  input.value = '';
  input.placeholder = typed || '';
  $('confirm-yes').disabled = !!typed;
  input.oninput = () => ($('confirm-yes').disabled = input.value !== typed);
  $('confirm').showModal();
  if (typed) input.focus();
  return new Promise((resolve) => {
    const done = (answer) => {
      $('confirm').close();
      $('confirm-yes').onclick = $('confirm-no').onclick = $('confirm').oncancel = null;
      resolve(answer);
    };
    $('confirm-yes').onclick = () => done(typed ? input.value : true);
    $('confirm-no').onclick = () => done(false);
    $('confirm').oncancel = () => done(false);
  });
}

// Where each framework keeps what users upload, as a hint in the folders field.
const UPLOADS = { wordpress: 'wp-content/uploads', bedrock: 'web/app/uploads', laravel: 'storage/app/public' };

let editing = null;
function openSettings(name) {
  editing = name;
  const env = name ? config.environments[name] : {};
  for (const input of form.querySelectorAll('input')) {
    if (input.name === 'backup') input.checked = env.backup !== false;
    else if (input.name === 'never') input.value = (env.never || []).join(', ');
    else if (input.name === 'env') input.value = name || (Object.keys(config.environments).length ? '' : 'production');
    else if (input.name === 'files') input.value = (env.files || []).join(', ');
    else if (input.name === 'db_password') {
      input.value = '';
      input.placeholder = env.db_password_set ? 'saved, type to change' : '';
    } else input.value = env[input.name] ?? '';
  }
  $('name-row').hidden = !!name;
  // Only WordPress keeps its own address in the database; elsewhere the field means nothing.
  $('url-row').hidden = !config.local?.wordpress && !env.url;
  form.elements.files.placeholder = UPLOADS[config.local?.framework] || 'public/uploads';
  $('remove').hidden = !name;
  $('form-error').hidden = true;
  $('settings-title').textContent = name ? `${name} server` : 'New environment';
  $('settings').showModal();
  form.elements[name ? 'ssh' : 'env'].focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = {};
  for (const input of form.querySelectorAll('input')) if (input.name !== 'env') fields[input.name] = input.type === 'checkbox' ? input.checked : input.value;
  const name = editing || form.elements.env.value.trim();
  let res;
  try {
    res = await api('env', { action: 'save-env', env: name, fields });
  } catch (err) {
    res = { error: err.message };
  }
  if (res.error) {
    $('form-error').textContent = res.error;
    $('form-error').hidden = false;
    return;
  }
  config = { ...config, ...res };
  delete health[name];
  $('settings').close();
  current = null;
  await select(name);
});

$('settings-cancel').addEventListener('click', () => $('settings').close());
$('remove').addEventListener('click', async () => {
  const name = editing;
  $('settings').close();
  if (!(await confirmDialog(`Remove ${name}?`, 'Only its settings here are forgotten; nothing on the server changes.', 'Remove'))) return;
  config = { ...config, ...(await api('env', { action: 'remove-env', env: name })) };
  if (current === name) current = null;
  const first = Object.keys(config.environments)[0];
  first ? select(first) : renderEnvs();
});

$('refresh').addEventListener('click', () => refresh());
$('sync-scroll').addEventListener('change', (e) => {
  syncScroll = e.target.checked;
  renderFiles();
  // Turning it on lines the remote side up with this one at once.
  const [local, remote] = ['#pane-local .rows', '#pane-remote .rows'].map((q) => document.querySelector(q));
  if (syncScroll && local && remote) remote.scrollTop = local.scrollTop;
});
$('expand-all').addEventListener('click', () => expandAll());
$('collapse-all').addEventListener('click', () => collapseAll());
$('picked-clear').addEventListener('click', () => {
  picked.local.clear();
  picked.remote.clear();
  renderFiles();
});
$('push-sel').addEventListener('click', () => transfer('push'));
$('pull-sel').addEventListener('click', () => transfer('pull'));
$('db-pull').addEventListener('click', () => runDb('pull'));
$('db-push').addEventListener('click', () => runDb('push'));
$('out-close').addEventListener('click', () => ($('out').hidden = true));

(async () => {
  try {
    config = await api('state');
  } catch (e) {
    showLog('loading', { ok: false, log: e.message });
  }
  const first = Object.keys(config.environments)[0];
  first ? select(first) : renderEnvs();
})();
