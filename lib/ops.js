// What the Sync tab, the terminal commands and the MCP tools do, shared so
// each surface runs the same code: listings, transfers, files, backups.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkSite, loadConfig, pickEnv, ssh, sh, sshArgs, remoteDatabase, pushScript, passwordInput, engineOf } = require('./remote');
const { site: findSite, siteDatabase, siteUrl, isWordPress, viewerSupported, lerdVersion } = require('./lerd');
const { removeRemoteCommand, backupRef, listLocalBackups, listRemoteBackupsCommand, parseRemoteBackups, backupFilesCommand, restoreFilesCommand, parseSnapshots } = require('./backups');
const { backupDir, backupNote, pruneBackups, cleanDir, listLocalTree, listRemoteTree, compare, transferArgs, countCommand, asText, readLocal, readRemoteCommand } = require('./files');

async function sitePath(name) {
  return process.env.LERD_SITE_PATH || (await findSite(name)).path;
}

// A folder of the project on both sides, one level or everything under it,
// keyed by folder, with how each name compares. Too much to expand is an
// answer for the page to show, not the plugin failing.
async function listing(site, opts) {
  const env = pickEnv(loadConfig(site), opts.env, { required: true });
  const dir = cleanDir(opts.dir);
  const all = !!opts.all;
  let local;
  try {
    local = listLocalTree(await sitePath(site), dir, { all });
  } catch (e) {
    if (/holds more than/.test(e.message)) return { dir, error: e.message };
    throw e;
  }
  let remote = {};
  let remoteError = '';
  try {
    remote = listRemoteTree(env, dir, { all });
  } catch (e) {
    if (all && /holds more than/.test(e.message)) return { dir, error: e.message };
    remoteError = e.message;
  }
  const status = {};
  if (!remoteError) for (const d of new Set([...Object.keys(local), ...Object.keys(remote)])) status[d] = compare(local[d] || [], remote[d] || []);
  return { dir, local, remote, status, remote_error: remoteError };
}

// What the tab shows about this side, and whether it is WordPress, which
// decides if the site address setting is offered at all.
async function localInfo(name) {
  try {
    const s = await findSite(name);
    let database = '';
    try {
      database = siteDatabase(s);
    } catch {}
    return { path: s.path.replace(require('node:os').homedir(), '~'), url: siteUrl(s), database, framework: s.framework || '', wordpress: isWordPress(s), viewer: viewerSupported(lerdVersion()) };
  } catch {
    return {};
  }
}

// How many files the picked paths hold on one side, folders counted through.
async function count(site, opts) {
  const env = pickEnv(loadConfig(site), opts.env, { required: true });
  const cmd = countCommand(opts.paths || []);
  const out = opts.side === 'remote'
    ? ssh(env, `cd ${sh(env.path)} && ${cmd}`)
    : spawnSync('sh', ['-c', cmd], { cwd: await sitePath(site), encoding: 'utf8' }).stdout;
  return { files: Number(String(out).trim()) || 0 };
}

const localBackups = (site) => path.join(process.env.LERD_PLUGIN_DATA, 'backups', checkSite(site));

function remoteHome(env) {
  const home = ssh(env, 'printf %s "$HOME"').trim();
  if (!home.startsWith('/')) throw new Error('could not find the home folder on the server');
  return home;
}

// The local database lerd serves this site from, for its snapshots.
async function localDb(site) {
  const s = await findSite(site);
  const service = (s.services || []).find((x) => engineOf(x));
  if (!service) return null;
  return { site: s, service, database: siteDatabase(s) };
}

// Everything kept for this site: file backups on both sides, the server's
// database backups and lerd's snapshots of the local database. A side that
// cannot be read says so instead of failing the rest.
async function backups(site, opts) {
  const env = pickEnv(loadConfig(site), opts.env, { required: true });
  const out = { items: listLocalBackups(localBackups(site)), snapshots: [], errors: [] };
  try {
    let database = '';
    try {
      database = remoteDatabase(env).database;
    } catch {}
    out.items.push(...parseRemoteBackups(ssh(env, listRemoteBackupsCommand(site, database))));
  } catch (e) {
    out.errors.push(`server: ${e.message}`);
  }
  out.items.sort((a, b) => b.stamp.localeCompare(a.stamp));
  try {
    const db = await localDb(site);
    if (db) {
      const r = spawnSync(process.env.LERD_BIN, ['db:snapshots', '-d', db.database, '-s', db.service], { cwd: db.site.path, encoding: 'utf8' });
      out.snapshots = parseSnapshots(r.stdout || '');
      out.local_database = db.database;
    }
  } catch (e) {
    out.errors.push(`snapshots: ${e.message}`);
  }
  return out;
}

// The files one push or pull backup holds.
async function backupFiles(site, opts) {
  const env = pickEnv(loadConfig(site), opts.env, { required: true });
  const ref = backupRef(site, opts.id);
  if (ref.kind !== 'push' && ref.kind !== 'pull') throw new Error('only file backups have files to list');
  const dir = ref.kind === 'pull' ? path.join(localBackups(site), ref.name) : `${remoteHome(env)}/.lerd-sync/files/${ref.name}`;
  const out = ref.kind === 'pull' ? spawnSync('sh', ['-c', backupFilesCommand(dir)], { encoding: 'utf8' }).stdout : ssh(env, backupFilesCommand(dir));
  const files = out.split('\n').filter(Boolean).map((l) => {
    const [size, ...p] = l.split('\t');
    return { path: p.join('\t'), size: Number(size) };
  });
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

// Puts a backup back where it came from. Files replaced by the restore are
// kept like any transfer's; a database is backed up again before its import.
async function restore(site, body) {
  const env = pickEnv(loadConfig(site), body.env, { required: true });
  const ref = backupRef(site, body.id);
  if (ref.kind === 'pull') {
    const keep = backupDir('pull', env, site);
    const r = spawnSync('sh', ['-c', restoreFilesCommand(path.join(localBackups(site), ref.name), await sitePath(site), keep)], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, log: r.stderr || 'restore failed' };
    const note = backupNote('pull', env, keep);
    pruneBackups('pull', env, keep);
    return { ok: true, log: [`restored the files kept on ${ref.stamp} into this site`, note].filter(Boolean).join('\n') };
  }
  if (ref.kind === 'push') {
    const keep = backupDir('push', env, site);
    const r = spawnSync('ssh', [...sshArgs(env), env.ssh, restoreFilesCommand(`${remoteHome(env)}/.lerd-sync/files/${ref.name}`, env.path, keep)], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, log: r.stderr || 'restore failed' };
    const note = backupNote('push', env, keep);
    pruneBackups('push', env, keep);
    return { ok: true, log: [`restored the files kept on ${ref.stamp} on ${env.name}`, note].filter(Boolean).join('\n') };
  }
  if (ref.kind === 'db') {
    if (body.confirm !== env.name) throw new Error('restoring a server database needs the environment name confirmed');
    const db = remoteDatabase(env);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const upload = `.lerd-sync/push-${stamp}.sql`;
    const size = ssh(env, `cp -- ${sh('.lerd-sync/' + ref.name)} ${sh(upload)} && wc -c < ${sh(upload)}`).trim();
    const r = spawnSync('ssh', [...sshArgs(env), env.ssh, pushScript(db, upload, `.lerd-sync/backup-${db.database}-${stamp}.sql`, size)], { encoding: 'utf8', input: passwordInput(db) || '' });
    return { ok: r.status === 0, log: `${r.stdout || ''}${r.stderr || ''}`.trim() || (r.status === 0 ? 'restored' : 'restore failed') };
  }
  const db = await localDb(site);
  if (!db) throw new Error(`${site} has no database in lerd`);
  const r = spawnSync(process.env.LERD_BIN, ['db:restore', ref.name, '-d', db.database, '-s', db.service, '--force'], { cwd: db.site.path, encoding: 'utf8' });
  return { ok: r.status === 0, log: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// Deletes one backup or snapshot for good; the page asked first.
async function removeBackup(site, body) {
  const env = pickEnv(loadConfig(site), body.env, { required: true });
  const ref = backupRef(site, body.id);
  if (ref.kind === 'pull') {
    fs.rmSync(path.join(localBackups(site), ref.name), { recursive: true, force: true });
    return { ok: true, log: `removed the backup kept on this site on ${ref.stamp}` };
  }
  if (ref.kind === 'snap') {
    const db = await localDb(site);
    if (!db) throw new Error(`${site} has no database in lerd`);
    const r = spawnSync(process.env.LERD_BIN, ['db:snapshot:rm', ref.name, '-d', db.database, '-s', db.service], { cwd: db.site.path, encoding: 'utf8' });
    return { ok: r.status === 0, log: `${r.stdout || ''}${r.stderr || ''}`.trim() };
  }
  ssh(env, removeRemoteCommand(ref));
  return { ok: true, log: `removed the ${ref.kind === 'db' ? 'database backup' : 'file backup'} kept on ${env.name} on ${ref.stamp}` };
}

// One file as text from one side, or null when it is binary or too large.
async function readSide(site, env, rel, side) {
  if (side === 'local') return asText(readLocal(await sitePath(site), rel));
  const r = spawnSync('ssh', [...sshArgs(env), env.ssh, readRemoteCommand(env.path, rel)], { maxBuffer: 3 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr).trim() || 'could not read it on the server');
  return asText(r.stdout);
}

async function readBackupFile(site, env, ref, rel) {
  if (ref.kind === 'pull') {
    const text = asText(readLocal(path.join(localBackups(site), ref.name), rel));
    if (text === null) throw new Error('not text, or over 2 MB, so it cannot be shown');
    return text;
  }
  if (ref.kind !== 'push') throw new Error('only file backups hold files');
  const r = spawnSync('ssh', [...sshArgs(env), env.ssh, readRemoteCommand(`${remoteHome(env)}/.lerd-sync/files/${ref.name}`, rel)], { maxBuffer: 3 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr).trim() || 'could not read it on the server');
  const text = asText(r.stdout);
  if (text === null) throw new Error('not text, or over 2 MB, so it cannot be shown');
  return text;
}

// Both versions of one file for lerd's diff, or with side just that one for
// lerd's viewer, or why neither can be shown.
async function fileVersions(site, opts) {
  const env = pickEnv(loadConfig(site), opts.env, { required: true });
  const rel = cleanDir(opts.file);
  if (opts.backup) {
    try {
      return { backup: await readBackupFile(site, env, backupRef(site, opts.backup), rel) };
    } catch (e) {
      return { error: e.message };
    }
  }
  const sides = opts.side ? [opts.side] : ['local', 'remote'];
  const out = {};
  try {
    for (const side of sides) out[side] = await readSide(site, env, rel, side);
  } catch (e) {
    return { error: e.message };
  }
  if (Object.values(out).includes(null)) return { error: 'not text, or over 2 MB, so it cannot be shown' };
  return out;
}

async function transfer(site, body) {
  const env = pickEnv(loadConfig(site), body.env, { required: true });
  const cwd = await sitePath(site);
  const keep = backupDir(body.direction, env, site);
  const r = spawnSync('rsync', transferArgs(body.direction, env, cwd, body.paths, keep), { cwd, encoding: 'utf8', maxBuffer: 16 << 20 });
  const log = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const verb = body.direction === 'push' ? `pushed to ${env.name}` : `pulled from ${env.name}`;
  if (r.status !== 0) return { ok: false, log: log || `rsync exited ${r.status}` };
  const note = backupNote(body.direction, env, keep);
  pruneBackups(body.direction, env, keep);
  return { ok: true, log: [log || 'nothing to copy, both sides already match', note, verb].filter(Boolean).join('\n') };
}


function testConnection(env) {
  const lines = [];
  try {
    ssh(env, `cd ${sh(env.path)}`);
    lines.push(`connected to ${env.ssh}, ${env.path} exists`);
    const db = remoteDatabase(env);
    lines.push(`database ${db.database} as ${db.db_user || 'root'}@${db.db_host || '127.0.0.1'}`);
    return { ok: true, database: db.database, log: lines.join('\n') };
  } catch (e) {
    return { ok: false, log: [...lines, e.message].join('\n') };
  }
}

// The scrub of one environment: whether a pull runs it, and the SQL it runs.
// on, off and save change it; the page never names the file, only its text.
async function scrub(site, opts) {
  const { saveConfig } = require('./remote');
  const { scrubInfo, scrubOn, scrubOff, scrubSave } = require('./scrub');
  const config = loadConfig(site);
  const env = config.environments[pickEnv(config, opts.env, { required: true }).name];
  const s = await findSite(site);
  if (opts.action === 'scrub-on') scrubOn(env, s.path, s.framework);
  else if (opts.action === 'scrub-off') scrubOff(env);
  else if (opts.action === 'scrub-save') scrubSave(env, s.path, opts.content);
  if (opts.action) saveConfig(site, config);
  return scrubInfo(env, s.path);
}

module.exports = { scrub, sitePath, listing, localInfo, count, backups, backupFiles, restore, removeBackup, fileVersions, transfer, testConnection, localDb, remoteHome };
