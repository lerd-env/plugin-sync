const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanDir, parseTree, listLocalTree, treeCommand, transferArgs, compare } = require('../lib/files');

test('cleanDir keeps a browsed folder inside the project', () => {
  assert.equal(cleanDir(''), '');
  assert.equal(cleanDir('/'), '');
  assert.equal(cleanDir('wp-content/uploads/'), 'wp-content/uploads');
  assert.equal(cleanDir('/wp-content'), 'wp-content', 'a leading slash means the project root');
  for (const bad of ['..', 'a/../../b', 'a//b', '-rf']) assert.throws(() => cleanDir(bad), /inside the project/);
});

test('parseTree groups find -printf lines by folder, folders first', () => {
  const out = 'f\t12\t1700000000.5\tb.jpg\nd\t4096\t1700000001.0\tuploads\nf\t3\t1700000002.0\tuploads/2026/x.txt\nd\t1\t1\tuploads/2026\n';
  assert.deepEqual(parseTree(out, 'wp-content'), {
    'wp-content': [
      { name: 'uploads', type: 'dir', size: 0, mtime: 1700000001 },
      { name: 'b.jpg', type: 'file', size: 12, mtime: 1700000000 },
    ],
    'wp-content/uploads': [{ name: '2026', type: 'dir', size: 0, mtime: 1 }],
    'wp-content/uploads/2026': [{ name: 'x.txt', type: 'file', size: 3, mtime: 1700000002 }],
  });
  assert.deepEqual(Object.keys(parseTree('d\t1\t1\ta\n', '')), ['']);
});

test('listLocalTree lists one level or everything, inside the project, up to a cap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-files-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'up', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(site, 'up', 'a.txt'), 'hi');
  fs.writeFileSync(path.join(site, 'up', 'deep', 'b.txt'), 'b');
  fs.symlinkSync(os.tmpdir(), path.join(site, 'escape'));
  fs.symlinkSync(site, path.join(site, 'up', 'loop'));
  const one = listLocalTree(site, 'up');
  assert.deepEqual(Object.keys(one), ['up']);
  assert.deepEqual(one.up.map((e) => [e.name, e.type]), [['deep', 'dir'], ['a.txt', 'file'], ['loop', 'file']]);
  const all = listLocalTree(site, 'up', { all: true });
  assert.deepEqual(Object.keys(all).sort(), ['up', 'up/deep'], 'a symlinked folder is listed, never walked into');
  assert.throws(() => listLocalTree(site, '', { all: true, max: 2 }), /more than 2/);
  assert.throws(() => listLocalTree(site, 'escape'), /inside the project/);
  assert.deepEqual(listLocalTree(site, 'missing'), { missing: [] });
});

test('treeCommand caps what the server lists and stays on one level unless asked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-rtree-'));
  fs.mkdirSync(path.join(root, 'up', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'up', 'deep', 'b.txt'), 'b');
  const run = (dir, opts) => require('node:child_process').execFileSync('sh', ['-c', treeCommand(root, dir, opts)]).toString();
  assert.deepEqual(Object.keys(parseTree(run('up'), 'up')), ['up']);
  assert.deepEqual(Object.keys(parseTree(run('up', { all: true }), 'up')).sort(), ['up', 'up/deep']);
  assert.equal(run('up', { all: true, max: 1 }).trim().split('\n').length, 2, 'one past the cap, so the cap can be told apart from exactly hitting it');
  assert.equal(run('missing'), '');
});

test('compare marks each name by which side has it and whether it differs', () => {
  const local = [{ name: 'a', type: 'file', size: 1, mtime: 10 }, { name: 'b', type: 'file', size: 2, mtime: 10 }, { name: 'd', type: 'dir', size: 0, mtime: 1 }];
  const remote = [{ name: 'a', type: 'file', size: 1, mtime: 10 }, { name: 'b', type: 'file', size: 3, mtime: 10 }, { name: 'c', type: 'file', size: 1, mtime: 1 }, { name: 'd', type: 'dir', size: 0, mtime: 9 }];
  assert.deepEqual(compare(local, remote), { a: 'same', b: 'changed', c: 'remote', d: 'both' });
});

test('transferArgs sends picked paths relative to the project, never the server config', () => {
  const env = { ssh: 'forge@h', path: '/srv/shop', ssh_port: '2222' };
  const push = transferArgs('push', env, '/home/u/shop', ['wp-content/uploads/a.jpg', 'wp-content/themes']);
  assert.deepEqual(push.slice(-4), ['--', './wp-content/uploads/a.jpg', './wp-content/themes', 'forge@h:/srv/shop/']);
  assert.ok(push.includes('--relative') && push.includes('--exclude=.env') && push.includes('--exclude=wp-config.php'));
  assert.ok(push.includes('ssh -o BatchMode=yes -o ConnectTimeout=15 -p 2222'));
  assert.ok(!push.includes('--delete'));
  // Without it rsync copies the local permissions onto every parent folder on the server, the web root included.
  assert.ok(push.includes('--no-implied-dirs'));
  const pull = transferArgs('pull', env, '/home/u/shop', ['wp-content/uploads']);
  assert.deepEqual(pull.slice(-3), ['--', 'forge@h:/srv/shop/./wp-content/uploads', '/home/u/shop/']);
  // The server's config would point the local site at production's database.
  assert.ok(pull.includes('--exclude=wp-config.php') && pull.includes('--exclude=.env'));
  assert.throws(() => transferArgs('pull', env, '/s', ['.env']), /never copied/);
  // Whatever a transfer replaces is kept first, on the side it was replaced on.
  const kept = transferArgs('push', env, '/home/u/shop', ['a.css'], '/home/forge/.lerd-sync/files/20261111T120000');
  assert.ok(kept.includes('--backup') && kept.includes('--backup-dir=/home/forge/.lerd-sync/files/20261111T120000'));
  assert.throws(() => transferArgs('push', env, '/s', ['a'], 'relative/dir'), /full path/);
  assert.throws(() => transferArgs('push', env, '/s', ['../x']), /inside the project/);
  assert.throws(() => transferArgs('push', env, '/s', ['wp-config.php']), /never copied/);
  assert.throws(() => transferArgs('push', env, '/s', []), /nothing picked/);
});

const { countCommand } = require('../lib/files');

test('countCommand counts the files inside picked folders, never the config files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-count-'));
  for (const f of ['up/2026/a.jpg', 'up/2026/b.jpg', 'up/c.jpg', 'up/.env', 'up/wp-config.php', 'top.txt', 'other/x']) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x');
  }
  const count = (paths) => Number(require('node:child_process').execFileSync('sh', ['-c', countCommand(paths)], { cwd: root }).toString().trim());
  assert.equal(count(['up']), 3);
  assert.equal(count(['up', 'top.txt']), 4);
  assert.equal(count(['up/2026/a.jpg']), 1);
  assert.equal(count(['missing']), 0, 'a path gone since the listing counts nothing');
  assert.equal(count([]), 0, 'nothing picked is not the whole project');
  assert.throws(() => countCommand(['../etc']), /inside the project/);
});

const { readLocal, readRemoteCommand, asText } = require('../lib/files');

test('asText hands back text and refuses binary or oversized files', () => {
  assert.equal(asText(Buffer.from('<?php echo 1;')), '<?php echo 1;');
  assert.equal(asText(Buffer.from([0xff, 0xd8, 0x00, 0x10])), null, 'a NUL byte means not text');
  assert.equal(asText(Buffer.alloc(2 * 1024 * 1024 + 1, 'a')), null);
});

test('readLocal reads a file inside the project only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-read-'));
  fs.mkdirSync(path.join(root, 'site', 'css'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site', 'css', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'secret'), 'x');
  fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'site', 'link'));
  assert.equal(readLocal(path.join(root, 'site'), 'css/a.css').toString(), 'body{}');
  assert.throws(() => readLocal(path.join(root, 'site'), 'link'), /inside the project/);
  assert.throws(() => readLocal(path.join(root, 'site'), '../secret'), /inside the project/);
});

test('readRemoteCommand reads one file, refusing more than the cap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-rread-'));
  fs.mkdirSync(path.join(root, 'css'));
  fs.writeFileSync(path.join(root, 'css', "it's.css"), 'body{}');
  fs.writeFileSync(path.join(root, 'big.txt'), 'a'.repeat(2 * 1024 * 1024 + 1));
  const run = (rel) => require('node:child_process').spawnSync('sh', ['-c', readRemoteCommand(root, rel)]);
  assert.equal(String(run("css/it's.css").stdout), 'body{}');
  assert.notEqual(run('big.txt').status, 0);
  assert.match(String(run('big.txt').stderr), /too large/);
  assert.throws(() => readRemoteCommand(root, '../etc/passwd'), /inside the project/);
});

const { pruneCommand, pruneLocal } = require('../lib/files');

test('pruneCommand keeps the newest backups of one site and leaves everything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-prune-'));
  for (const n of ['shop-20260101T000000', 'shop-20260301T000000', 'shop-20260201T000000', 'shop-20260401T000000', 'shop-2-20260101T000000', 'notes.txt']) {
    fs.mkdirSync(path.join(dir, n));
    fs.writeFileSync(path.join(dir, n, 'f'), 'x');
  }
  require('node:child_process').execFileSync('sh', ['-c', pruneCommand(dir, 'shop-', 2)]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'shop-2-20260101T000000', 'shop-20260301T000000', 'shop-20260401T000000']);
  assert.throws(() => pruneCommand(dir, 'shop-', 0), /at least 1/);
});

test('pruneLocal keeps the newest backup folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-prunel-'));
  for (const n of ['20260101T000000', '20260301T000000', '20260201T000000']) fs.mkdirSync(path.join(dir, n));
  pruneLocal(dir, 1);
  assert.deepEqual(fs.readdirSync(dir), ['20260301T000000']);
  pruneLocal(path.join(dir, 'missing'), 1);
});
