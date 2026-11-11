const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { backupRef, listLocalBackups, listRemoteBackupsCommand, parseRemoteBackups, backupFilesCommand, restoreFilesCommand } = require('../lib/backups');

const sh = (cmd, cwd) => execFileSync('sh', ['-c', cmd], { cwd }).toString();
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-${name}-`));
function put(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

test('backupRef only names a backup of this site, never a path', () => {
  assert.deepEqual(backupRef('shop', 'push:shop-20261111T104156'), { kind: 'push', name: 'shop-20261111T104156', stamp: '20261111T104156' });
  assert.deepEqual(backupRef('shop', 'pull:20261111T104214'), { kind: 'pull', name: '20261111T104214', stamp: '20261111T104214' });
  assert.deepEqual(backupRef('shop', 'db:backup-shop_prod-20261111T104210.sql'), { kind: 'db', name: 'backup-shop_prod-20261111T104210.sql', stamp: '20261111T104210' });
  for (const bad of ['push:other-20261111T104156', 'push:shop-2026', 'pull:../x', 'db:backup-x-20261111T104210.sql/../../y', 'nope:x', 'push:shop-20261111T104156/..']) {
    assert.throws(() => backupRef('shop', bad), /not a backup/);
  }
});

test('listLocalBackups counts the files and bytes of each pull backup, newest first', () => {
  const dir = tmp('lb');
  put(dir, { '20260101T000000/a/b.txt': 'abc', '20260201T000000/x.txt': 'x', '20260201T000000/y/z.txt': 'zz', 'stray/q': 'q' });
  assert.deepEqual(listLocalBackups(dir), [
    { id: 'pull:20260201T000000', kind: 'pull', stamp: '20260201T000000', files: 2, bytes: 3 },
    { id: 'pull:20260101T000000', kind: 'pull', stamp: '20260101T000000', files: 1, bytes: 3 },
  ]);
  assert.deepEqual(listLocalBackups(path.join(dir, 'missing')), []);
});

test('the server listing finds this site\'s file and database backups only', () => {
  const home = tmp('rb');
  put(home, {
    '.lerd-sync/files/shop-20260101T000000/wp/a.css': 'aaaa',
    '.lerd-sync/files/shop-2-20260101T000000/x': 'x',
    '.lerd-sync/backup-shop_prod-20260102T000000.sql': 'dump!',
    '.lerd-sync/backup-other-20260102T000000.sql': 'no',
  });
  const out = sh(listRemoteBackupsCommand('shop', 'shop_prod'), home);
  assert.deepEqual(parseRemoteBackups(out), [
    { id: 'db:backup-shop_prod-20260102T000000.sql', kind: 'db', stamp: '20260102T000000', files: 1, bytes: 5 },
    { id: 'push:shop-20260101T000000', kind: 'push', stamp: '20260101T000000', files: 1, bytes: 4 },
  ]);
  assert.deepEqual(parseRemoteBackups(sh(listRemoteBackupsCommand('shop', 'shop_prod'), tmp('empty'))), []);
});

test('backupFilesCommand lists what one backup holds, relative to the project', () => {
  const dir = tmp('bf');
  put(dir, { 'shop-20260101T000000/wp/a.css': 'aaaa', 'shop-20260101T000000/b.txt': 'b' });
  assert.deepEqual(sh(backupFilesCommand(path.join(dir, 'shop-20260101T000000')), dir).trim().split('\n').sort(), ['1\tb.txt', '4\twp/a.css']);
});

test('restoreFilesCommand puts a backup back and keeps what it replaces', () => {
  const root = tmp('rs');
  put(root, { 'site/wp/a.css': 'new', 'site/keep.txt': 'untouched', 'bk/wp/a.css': 'old' });
  const r = spawnSync('sh', ['-c', restoreFilesCommand(path.join(root, 'bk'), path.join(root, 'site'), path.join(root, 'kept'))]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(fs.readFileSync(path.join(root, 'site/wp/a.css'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(root, 'site/keep.txt'), 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(path.join(root, 'kept/wp/a.css'), 'utf8'), 'new');
});

const { parseSnapshots } = require('../lib/backups');

test('parseSnapshots reads lerd db:snapshots, newest first as lerd prints it', () => {
  const out = [
    'NAME                                CREATED           DATABASE  SIZE      BRANCH  RETENTION',
    'auto-20261111-101830                2026-11-11 12:18  rp_wp     21.5 KiB  -       auto, ~19h',
    'before-sync-pull-20261111-100620  2026-11-11 12:06  rp_wp     21.5 KiB  -       manual',
    '',
  ].join('\n');
  assert.deepEqual(parseSnapshots(out), [
    { id: 'snap:auto-20261111-101830', kind: 'snapshot', name: 'auto-20261111-101830', created: '2026-11-11 12:18', size: '21.5 KiB' },
    { id: 'snap:before-sync-pull-20261111-100620', kind: 'snapshot', name: 'before-sync-pull-20261111-100620', created: '2026-11-11 12:06', size: '21.5 KiB' },
  ]);
  assert.deepEqual(parseSnapshots('No snapshots for rp_wp\n'), []);
});

const { removeRemoteCommand } = require('../lib/backups');

test('removeRemoteCommand deletes just the one backup it names', () => {
  const home = tmp('rm');
  put(home, {
    '.lerd-sync/files/shop-20260101T000000/a.css': 'a',
    '.lerd-sync/files/shop-20260201T000000/b.css': 'b',
    '.lerd-sync/backup-shop_prod-20260102T000000.sql': 'x',
    '.lerd-sync/backup-shop_prod-20260103T000000.sql': 'y',
  });
  sh(removeRemoteCommand(backupRef('shop', 'push:shop-20260101T000000')), home);
  sh(removeRemoteCommand(backupRef('shop', 'db:backup-shop_prod-20260102T000000.sql')), home);
  assert.deepEqual(fs.readdirSync(path.join(home, '.lerd-sync/files')), ['shop-20260201T000000']);
  assert.deepEqual(fs.readdirSync(path.join(home, '.lerd-sync')).sort(), ['backup-shop_prod-20260103T000000.sql', 'files']);
  assert.throws(() => removeRemoteCommand({ kind: 'pull', name: '20260101T000000' }), /server/);
});
