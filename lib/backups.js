// Listing and restoring what transfers kept: replaced files on either side,
// the server's database backups, and lerd's own snapshots of the local one.
const fs = require('node:fs');
const path = require('node:path');
const { sh } = require('./remote');

const STAMP = '\\d{8}T\\d{6}';

// A backup id from the page, checked against this site's naming so it can
// only ever name one backup and never a path.
function backupRef(site, id) {
  const [kind, ...rest] = String(id).split(':');
  const name = rest.join(':');
  const esc = site.replace(/[^a-z0-9-]/g, '');
  const forms = {
    push: new RegExp(`^${esc}-(${STAMP})$`),
    pull: new RegExp(`^(${STAMP})$`),
    db: new RegExp(`^backup-[A-Za-z0-9_$-]+-(${STAMP})\\.sql$`),
    snap: /^[A-Za-z0-9][\w.-]*$/,
  };
  const m = forms[kind] && name.match(forms[kind]);
  if (!m || esc !== site) throw new Error(`${id} is not a backup of ${site}`);
  return kind === 'snap' ? { kind, name } : { kind, name, stamp: m[1] };
}

function walkCount(dir) {
  let files = 0;
  let bytes = 0;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      const sub = walkCount(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (d.isFile()) {
      files++;
      bytes += fs.statSync(p).size;
    }
  }
  return { files, bytes };
}

// Pull backups live in lerd's data folder, one per transfer.
function listLocalBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => new RegExp(`^${STAMP}$`).test(n));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return names.sort().reverse().map((n) => ({ id: `pull:${n}`, kind: 'pull', stamp: n, ...walkCount(path.join(dir, n)) }));
}

// One line per backup on the server, run from its home: kind, name, files, bytes.
function listRemoteBackupsCommand(site, database) {
  const glob = '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]';
  return [
    'cd .lerd-remote-pull 2>/dev/null || exit 0',
    `for d in files/${sh(site + '-')}${glob}; do [ -d "$d" ] || continue; printf 'push\\t%s\\t' "\${d#files/}"; find "$d" -type f -printf '%s\\n' | awk '{n++; s+=$1} END {printf "%d\\t%d\\n", n, s}'; done`,
    database ? `for f in ${sh('backup-' + database + '-')}${glob}.sql; do [ -f "$f" ] || continue; printf 'db\\t%s\\t1\\t%s\\n' "$f" "$(wc -c < "$f" | tr -d ' ')"; done` : 'true',
  ].join('; ');
}

function parseRemoteBackups(out) {
  const items = [];
  for (const line of out.split('\n')) {
    const [kind, name, files, bytes] = line.split('\t');
    if (!bytes) continue;
    const stamp = name.match(new RegExp(STAMP))[0];
    items.push({ id: `${kind}:${name}`, kind, stamp, files: Number(files), bytes: Number(bytes) });
  }
  return items.sort((a, b) => b.stamp.localeCompare(a.stamp) || a.kind.localeCompare(b.kind));
}

// Size and project-relative path of every file one backup holds.
function backupFilesCommand(dir) {
  return `cd ${sh(dir)} && find . -type f -printf '%s\\t%P\\n'`;
}

// Copies a backup over the project, keeping what it replaces in keepDir, so a
// restore can itself be undone. Run on whichever side the backup belongs to.
function restoreFilesCommand(backup, project, keepDir) {
  const keep = keepDir ? `--backup --backup-dir=${sh(keepDir)} ` : '';
  // --ignore-times: a backup the same size and age as the file it replaces is still copied.
  return `rsync -a --ignore-times ${keep}-- ${sh(backup + '/')} ${sh(project + '/')}`;
}

// Deletes one checked backup on the server, run from its home.
function removeRemoteCommand(ref) {
  if (ref.kind === 'push') return `rm -rf -- ${sh('.lerd-remote-pull/files/' + ref.name)}`;
  if (ref.kind === 'db') return `rm -f -- ${sh('.lerd-remote-pull/' + ref.name)}`;
  throw new Error(`a ${ref.kind} backup is not kept on the server`);
}

// lerd db:snapshots prints a table; its columns are split on runs of spaces.
function parseSnapshots(out) {
  const lines = out.split('\n').filter((l) => l.trim());
  if (!lines.length || !/^NAME\s/.test(lines[0])) return [];
  return lines.slice(1).map((l) => {
    const [name, created, , size] = l.trim().split(/\s{2,}/);
    return { id: `snap:${name}`, kind: 'snapshot', name, created, size };
  });
}

module.exports = { removeRemoteCommand, backupRef, listLocalBackups, listRemoteBackupsCommand, parseRemoteBackups, backupFilesCommand, restoreFilesCommand, parseSnapshots };
