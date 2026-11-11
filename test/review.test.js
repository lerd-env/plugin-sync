// Fixes from reviewing the plugin as a catalog submission.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupDir, pruneLocal, transferArgs } = require('../lib/files');
const { backupRef, listLocalBackups } = require('../lib/backups');
const { applyEnv, pickEnv } = require('../lib/remote');

test('two pulls in the same second keep separate backups', () => {
  process.env.LERD_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-uniq-'));
  const first = backupDir('pull', {}, 'shop');
  fs.mkdirSync(first, { recursive: true });
  const second = backupDir('pull', {}, 'shop');
  assert.notEqual(second, first);
  fs.mkdirSync(second, { recursive: true });
  const names = listLocalBackups(path.dirname(first)).map((b) => b.id);
  assert.equal(names.length, 2);
  for (const id of names) assert.doesNotThrow(() => backupRef('shop', id), id);
  pruneLocal(path.dirname(first), 1);
  assert.equal(fs.readdirSync(path.dirname(first)).length, 1, 'a numbered backup is pruned like any other');
});

test('a scrub file is SQL inside the project', () => {
  const config = { environments: {} };
  applyEnv(config, 'prod', { ssh: 'a@b', path: '/p', sanitize: '.lerd/scrub-prod.sql' });
  for (const bad of ['public/index.php', '.env', 'scrub.sql.php']) assert.throws(() => applyEnv(config, 'prod', { sanitize: bad }), /\.sql/, bad);
});

test('a pull drops symlinks that point outside the project', () => {
  assert.ok(transferArgs('pull', { ssh: 'a@b', path: '/srv' }, '/s', ['up']).includes('--safe-links'));
});

test('without an environment named, the site command pulls from production, or the first one', () => {
  const two = { environments: { staging: { ssh: 's@h' }, production: { ssh: 'p@h' } } };
  assert.equal(pickEnv(two, undefined, { preferProduction: true }).name, 'production');
  assert.equal(pickEnv({ environments: { staging: {}, qa: {} } }, undefined, { preferProduction: true }).name, 'staging');
  assert.throws(() => pickEnv(two), /pick one with --env/, 'the terminal still asks');
});

const { rsyncUsable } = require('../lib/files');

test('rsyncUsable wants rsync 3, which has --protect-args', () => {
  assert.equal(rsyncUsable('rsync  version 3.4.1  protocol version 32\nCopyright'), true);
  assert.equal(rsyncUsable('rsync  version 3.0.0  protocol version 30'), true);
  assert.equal(rsyncUsable('rsync  version 2.6.9  protocol version 29'), false);
  assert.equal(rsyncUsable('openrsync: protocol version 29\nrsync version 2.6.9 compatible'), false);
  assert.equal(rsyncUsable(''), false);
});

const { listBackupFiles } = require('../lib/backups');

test('listBackupFiles lists a local backup with sizes and project paths, without GNU find', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lbf-'));
  fs.mkdirSync(path.join(dir, 'wp', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wp', 'x', 'a.css'), 'aaaa');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  assert.deepEqual(listBackupFiles(dir), [{ path: 'b.txt', size: 1 }, { path: 'wp/x/a.css', size: 4 }]);
});
