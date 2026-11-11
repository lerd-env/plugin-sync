// Browsing both copies of a project and moving picked paths between them.
const fs = require('node:fs');
const path = require('node:path');
const { ssh, sh, sshArgs } = require('./remote');

// Each side's own settings: copying them across would point a server at the
// local database or the local site at production's. Never transferred.
const NEVER_PUSH = ['.env', 'wp-config.php'];

// A folder or file the page names, relative to the project; '' is its root.
function cleanDir(dir) {
  const d = String(dir || '').replace(/^\/+|\/+$/g, '');
  if (!d) return '';
  if (d.split('/').some((p) => p === '..' || p === '') || d.startsWith('-')) throw new Error(`${dir} must be a path inside the project`);
  return d;
}

// Expanding everything stops here, so a vendor or node_modules folder cannot
// stall the tab; the user opens a smaller folder instead.
const TREE_MAX = 5000;

function sortEntries(entries) {
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

function tooMany(dir, max) {
  return new Error(`${dir || 'the project'} holds more than ${max} files and folders; open a smaller folder to expand everything in it`);
}

// Lines of `find -printf '%y\t%s\t%T@\t%P\n'` under base, grouped by the
// project-relative folder each sits in. The base itself is always present.
function parseTree(out, base) {
  const tree = { [base]: [] };
  for (const line of out.split('\n')) {
    const [type, size, mtime, ...rest] = line.split('\t');
    if (!rest.length) continue;
    const rel = rest.join('\t');
    const slash = rel.lastIndexOf('/');
    const parent = [base, slash < 0 ? '' : rel.slice(0, slash)].filter(Boolean).join('/');
    const dir = type === 'd';
    (tree[parent] ||= []).push({ name: rel.slice(slash + 1), type: dir ? 'dir' : 'file', size: dir ? 0 : Number(size), mtime: Math.floor(Number(mtime)) });
  }
  for (const k of Object.keys(tree)) sortEntries(tree[k]);
  return tree;
}

// One folder, or with all everything under it. Symlinks are listed as files
// and never walked, so a link cannot lead out of the project or loop.
function listLocalTree(sitePath, dir, { all = false, max = TREE_MAX } = {}) {
  const root = fs.realpathSync(sitePath);
  const base = cleanDir(dir);
  let full;
  try {
    full = fs.realpathSync(path.join(root, base));
  } catch (e) {
    if (e.code === 'ENOENT') return { [base]: [] };
    throw e;
  }
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`${dir} must be a path inside the project`);
  const tree = {};
  let count = 0;
  const walk = (abs, rel) => {
    const entries = (tree[rel] = []);
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (++count > max) throw tooMany(base, max);
      let st;
      try {
        st = fs.lstatSync(path.join(abs, d.name));
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      entries.push({ name: d.name, type: isDir ? 'dir' : 'file', size: isDir ? 0 : st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      if (isDir && all) walk(path.join(abs, d.name), rel ? `${rel}/${d.name}` : d.name);
    }
    sortEntries(entries);
  };
  walk(full, base);
  return tree;
}

// Prints at most max + 1 lines, so the caller can tell the cap was passed.
function treeCommand(projectPath, dir, { all = false, max = TREE_MAX } = {}) {
  const target = sh(path.posix.join(projectPath, cleanDir(dir)));
  return `cd ${target} 2>/dev/null || exit 0; find . -mindepth 1 ${all ? '' : '-maxdepth 1 '}-printf '%y\\t%s\\t%T@\\t%P\\n' | head -n ${max + 1}`;
}

function listRemoteTree(env, dir, { all = false, max = TREE_MAX } = {}) {
  const base = cleanDir(dir);
  const out = ssh(env, treeCommand(env.path, base, { all, max }));
  if (out.split('\n').filter(Boolean).length > max) throw tooMany(base, max);
  return parseTree(out, base);
}

// Per name: on one side only, or on both and whether the files look alike.
// Folders on both sides are just "both"; their contents are compared inside.
function compare(local, remote) {
  const out = {};
  const r = new Map(remote.map((e) => [e.name, e]));
  for (const l of local) {
    const o = r.get(l.name);
    if (!o) out[l.name] = 'local';
    else if (l.type === 'dir' || o.type === 'dir') out[l.name] = 'both';
    else out[l.name] = l.size === o.size ? 'same' : 'changed';
  }
  for (const o of remote) if (!(o.name in out)) out[o.name] = 'remote';
  return out;
}

// lerd's diff takes up to 2 MB a side; past that, or with a NUL byte, a file is
// not something a line diff can show.
const TEXT_MAX = 2 * 1024 * 1024;
function asText(buf) {
  if (buf.length > TEXT_MAX || buf.includes(0)) return null;
  return buf.toString('utf8');
}

function readLocal(sitePath, rel) {
  const root = fs.realpathSync(sitePath);
  const full = fs.realpathSync(path.join(root, cleanDir(rel)));
  if (!full.startsWith(root + path.sep)) throw new Error(`${rel} must be a path inside the project`);
  return fs.readFileSync(full);
}

// Prints one file of the project on the server, or fails when it is too large
// to diff, so a big file is never pulled over ssh just to be thrown away.
function readRemoteCommand(projectPath, rel) {
  const f = sh(path.posix.join(projectPath, cleanDir(rel)));
  return `[ -f ${f} ] || { echo 'not a file on the server' >&2; exit 1; }; [ "$(wc -c < ${f} | tr -d ' ')" -le ${TEXT_MAX} ] || { echo 'too large to diff' >&2; exit 1; }; cat ${f}`;
}

// A shell command, run in the project's folder on either side, printing how
// many files the picked paths hold, the way a transfer would count them.
function countCommand(paths) {
  const rel = paths.map(cleanDir).filter(Boolean);
  if (!rel.length) return 'echo 0';
  const skip = NEVER_PUSH.map((f) => `! -name ${sh(f)}`).join(' ');
  return `find ${rel.map((p) => sh('./' + p)).join(' ')} -type f ${skip} 2>/dev/null | wc -l`;
}

// rsync arguments that copy the picked paths, keeping each at the same place
// relative to the project on the other side. Nothing is ever deleted.
// Where a transfer keeps the files it replaces, on the side it replaces them:
// lerd's data folder for a pull, the server's home for a push, never the web
// root. Null when the environment turned backups off.
function backupDir(direction, env, siteName) {
  if (env.backup === false) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  if (direction === 'pull') return path.join(process.env.LERD_PLUGIN_DATA, 'backups', siteName, stamp);
  const home = ssh(env, 'printf %s "$HOME"').trim();
  if (!home.startsWith('/')) throw new Error('could not find the home folder on the server for the backup');
  return `${home}/.lerd-sync/files/${siteName}-${stamp}`;
}

// A line saying where replaced files went, or nothing when none were replaced.
function backupNote(direction, env, dir) {
  if (!dir) return '';
  const made = direction === 'pull' ? fs.existsSync(dir) : ssh(env, `[ -d ${sh(dir)} ] && echo yes || true`).trim() === 'yes';
  return made ? `replaced files were kept in ${dir}${direction === 'push' ? ' on the server' : ''}` : '';
}

// Backups kept per environment and side when the user set no number.
const KEEP_DEFAULT = 10;
const STAMP_GLOB = '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]';

// Deletes all but the newest keep entries named <prefix><stamp> in dir, on the
// server. The stamp pattern keeps a site named shop-2 out of shop's backups.
function pruneCommand(dir, prefix, keep) {
  if (!(keep >= 1)) throw new Error('keep at least 1 backup');
  return `cd ${sh(dir)} 2>/dev/null || exit 0; ls -1d -- ${sh(prefix)}${STAMP_GLOB}* 2>/dev/null | sort -r | tail -n +${keep + 1} | while IFS= read -r d; do rm -rf -- "$d"; done`;
}

function pruneLocal(dir, keep) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{8}T\d{6}$/.test(n));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const n of names.sort().reverse().slice(keep)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

// After a transfer, the side that took the backup drops its oldest beyond the
// environment's number.
function pruneBackups(direction, env, dir) {
  if (!dir) return;
  const keep = env.keep || KEEP_DEFAULT;
  if (direction === 'pull') return pruneLocal(path.dirname(dir), keep);
  const base = path.posix.basename(dir);
  ssh(env, pruneCommand(path.posix.dirname(dir), base.slice(0, -15), keep));
}

// With backupDir, every file the transfer replaces is first moved there, on
// the side it was replaced on, keeping its place in the project.
function transferArgs(direction, env, sitePath, paths, backupDir) {
  if (!paths?.length) throw new Error('nothing picked to transfer');
  const rel = paths.map(cleanDir).filter(Boolean);
  if (rel.length !== paths.length) throw new Error('the project root itself cannot be picked; open it and pick inside');
  const blocked = rel.find((p) => NEVER_PUSH.includes(path.posix.basename(p)));
  if (blocked) throw new Error(`${blocked} is never copied between the site and a server`);
  const exclude = NEVER_PUSH.map((f) => `--exclude=${f}`);
  if (backupDir && !backupDir.startsWith('/')) throw new Error(`the backup folder ${backupDir} must be a full path`);
  const keep = backupDir ? ['--backup', `--backup-dir=${backupDir}`] : [];
  const base = ['-az', '--relative', '--no-implied-dirs', '--itemize-changes', ...keep, '-e', ['ssh', ...sshArgs(env)].join(' ')];
  if (direction === 'push') {
    return [...base, ...exclude, '--', ...rel.map((p) => `./${p}`), `${env.ssh}:${env.path}/`];
  }
  if (direction === 'pull') {
    return [...base, ...exclude, '--', ...rel.map((p) => `${env.ssh}:${env.path}/./${p}`), sitePath.replace(/\/+$/, '') + '/'];
  }
  throw new Error(`unknown direction ${direction}`);
}

module.exports = { KEEP_DEFAULT, pruneCommand, pruneLocal, pruneBackups, backupDir, backupNote, NEVER_PUSH, TREE_MAX, asText, readLocal, readRemoteCommand, cleanDir, countCommand, parseTree, listLocalTree, treeCommand, listRemoteTree, compare, transferArgs };
