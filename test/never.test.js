const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BUILTIN_NEVER, neverRules, isLocked, transferArgs, countCommand } = require('../lib/files');
const { applyEnv } = require('../lib/remote');

test('the built-in rules keep each side its own config, lerd setup and repository', () => {
  const rules = BUILTIN_NEVER;
  for (const p of ['.env', '.env.local', 'app/.env.prod', 'wp-config.php', '.lerd', '.lerd/scrub.sql', '.lerd.yaml', '.git', '.git/config', 'sites/default/settings.php', 'web/sites/default/settings.local.php']) {
    assert.equal(isLocked(p, rules), true, p);
  }
  for (const p of ['wp-content/plugins/shop/settings.php', 'docs/.lerd/x', 'my.env', 'wp-config-sample.php', 'config/application.php', 'src/.gitkeep']) {
    assert.equal(isLocked(p, rules), false, p);
  }
});

test('an environment adds names, files and folders of its own on top', () => {
  const rules = neverRules({ never: ['*.log', 'wp-content/cache/', '/robots.txt'] });
  assert.ok(rules.includes('.env'), 'the built-ins always stay');
  for (const p of ['debug.log', 'wp-content/debug.log', 'wp-content/cache', 'wp-content/cache/page.html', 'robots.txt']) assert.equal(isLocked(p, rules), true, p);
  for (const p of ['wp-content/cache-old/x', 'public/robots.txt', 'log.txt']) assert.equal(isLocked(p, rules), false, p);
});

test('applyEnv checks the never-sync list and keeps it tidy', () => {
  const config = { environments: {} };
  applyEnv(config, 'prod', { ssh: 'a@b', path: '/p', never: ' *.log, wp-content/cache/ ,, ' });
  assert.deepEqual(config.environments.prod.never, ['*.log', 'wp-content/cache/']);
  applyEnv(config, 'prod', { never: '' });
  assert.equal(config.environments.prod.never, undefined);
  for (const bad of ['../x', 'a/../../b', '-rf', 'a b\nc']) assert.throws(() => applyEnv(config, 'prod', { never: bad }), /never sync/, bad);
});

test('transfers exclude every rule and refuse a locked path or anything inside one', () => {
  const env = { ssh: 'a@b', path: '/srv', never: ['wp-content/cache/'] };
  const args = transferArgs('push', env, '/s', ['wp-content/uploads']);
  for (const r of ['.env', '/.git/', '/.lerd/', 'wp-content/cache/']) assert.ok(args.includes(`--exclude=${r.includes('/') && !r.startsWith('/') ? '/' + r : r}`), r);
  assert.throws(() => transferArgs('push', env, '/s', ['.git/config']), /never copied/);
  assert.throws(() => transferArgs('pull', env, '/s', ['wp-content/cache/x.html']), /never copied/);
});

test('countCommand leaves locked files and folders out of the count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-never-'));
  for (const f of ['a.txt', '.env', '.git/HEAD', '.git/objects/x', '.lerd/scrub.sql', 'up/b.txt', 'up/.env.local', 'cache/c.html']) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  const count = (paths, rules) => Number(execFileSync('sh', ['-c', countCommand(paths, rules)], { cwd: dir }).toString().trim());
  assert.equal(count(['a.txt', '.env', '.git', '.lerd', 'up', 'cache'], neverRules({})), 3);
  assert.equal(count(['a.txt', 'up', 'cache'], neverRules({ never: ['cache/'] })), 2);
});
