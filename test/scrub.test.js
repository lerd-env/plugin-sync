const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tablePrefix, scrubTemplate } = require('../lib/scrub');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-scrub-'));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

test('tablePrefix reads WordPress and Bedrock prefixes, wp_ when unset', () => {
  assert.equal(tablePrefix(project({ 'wp-config.php': "<?php\n$table_prefix = 'shop_';\n" }), 'wordpress'), 'shop_');
  assert.equal(tablePrefix(project({ 'wp-config.php': '<?php\n$table_prefix  =  "x1_" ;\n' }), 'wordpress'), 'x1_');
  assert.equal(tablePrefix(project({ '.env': "DB_NAME=a\nDB_PREFIX='bd_'\n" }), 'bedrock'), 'bd_');
  assert.equal(tablePrefix(project({}), 'wordpress'), 'wp_');
  // A prefix goes straight into SQL, so anything but a plain identifier is refused.
  assert.throws(() => tablePrefix(project({ 'wp-config.php': "$table_prefix = 'x; DROP TABLE y; --';" }), 'wordpress'), /prefix/);
});

test('scrubTemplate fills the WordPress prefix and only touches core tables', () => {
  const sql = scrubTemplate('wordpress', 'shop_');
  assert.match(sql, /UPDATE shop_users SET user_email/);
  assert.match(sql, /UPDATE shop_comments SET/);
  assert.ok(!sql.includes('{prefix}'));
  assert.ok(!/woocommerce_|wc_orders/.test(sql.replace(/^--.*$/gm, '')), 'a table WooCommerce may not have created must not be required');
  assert.equal(scrubTemplate('bedrock', 'bd_').includes('UPDATE bd_users'), true);
});

test('scrubTemplate for Laravel touches users only and leaves the rest commented', () => {
  const live = scrubTemplate('laravel', '').split('\n').filter((l) => l.trim() && !l.startsWith('--'));
  assert.equal(live.length, 1);
  assert.match(live[0], /^UPDATE users SET email/);
});

test('scrubTemplate for anything else is a commented starting point', () => {
  const sql = scrubTemplate('symfony', '');
  assert.ok(sql.split('\n').every((l) => !l.trim() || l.startsWith('--')));
});

const { scrubOn, scrubOff, scrubSave, scrubInfo } = require('../lib/scrub');

test('turning scrubbing on writes the default once and never over an edited file', () => {
  const dir = project({ 'wp-config.php': "$table_prefix = 'shop_';" });
  const env = {};
  scrubOn(env, dir, 'wordpress');
  assert.equal(env.sanitize, '.lerd/scrub.sql');
  assert.match(fs.readFileSync(path.join(dir, '.lerd/scrub.sql'), 'utf8'), /UPDATE shop_users/);
  scrubSave(env, dir, 'DELETE FROM shop_sessions;\n');
  scrubOff(env);
  assert.equal(env.sanitize, undefined);
  scrubOn(env, dir, 'wordpress');
  assert.equal(fs.readFileSync(path.join(dir, '.lerd/scrub.sql'), 'utf8'), 'DELETE FROM shop_sessions;\n', 'an edited file survives off and on');
  assert.deepEqual(scrubInfo(env, dir), { enabled: true, path: '.lerd/scrub.sql', exists: true, content: 'DELETE FROM shop_sessions;\n', own: false });
});

test('scrubSave keeps the file inside the project and refuses huge text', () => {
  const dir = project({});
  assert.throws(() => scrubSave({ sanitize: '../outside.sql' }, dir, 'x'), /inside the project/);
  assert.throws(() => scrubSave({}, dir, 'x'.repeat(1024 * 1024 + 1)), /too large/);
  assert.deepEqual(scrubInfo({}, dir), { enabled: false, path: '.lerd/scrub.sql', exists: false, content: '', own: false });
});

const { scrubUseFile } = require('../lib/scrub');

test('an environment can switch to its own scrub file, which starts as a copy of the shared one', () => {
  const dir = project({ 'wp-config.php': "$table_prefix = 'shop_';" });
  const staging = { name: 'staging' };
  scrubOn(staging, dir, 'wordpress');
  scrubSave(staging, dir, 'SHARED;\n');
  scrubUseFile(staging, dir, 'wordpress', 'own');
  assert.equal(staging.sanitize, '.lerd/scrub-staging.sql');
  assert.equal(fs.readFileSync(path.join(dir, '.lerd/scrub-staging.sql'), 'utf8'), 'SHARED;\n');
  scrubSave(staging, dir, 'STAGING ONLY;\n');
  scrubUseFile(staging, dir, 'wordpress', 'shared');
  assert.equal(staging.sanitize, '.lerd/scrub.sql');
  assert.equal(fs.readFileSync(path.join(dir, '.lerd/scrub.sql'), 'utf8'), 'SHARED;\n', 'the shared file is untouched');
  scrubUseFile(staging, dir, 'wordpress', 'own');
  assert.equal(fs.readFileSync(path.join(dir, '.lerd/scrub-staging.sql'), 'utf8'), 'STAGING ONLY;\n', 'its own file is kept, never recopied');
  assert.equal(scrubInfo(staging, dir).own, true);
  assert.throws(() => scrubUseFile(staging, dir, 'wordpress', 'mine'), /shared or own/);
});

test('with no shared file yet, an own file starts from the framework default', () => {
  const dir = project({});
  const prod = { name: 'production' };
  scrubUseFile(prod, dir, 'laravel', 'own');
  assert.match(fs.readFileSync(path.join(dir, '.lerd/scrub-production.sql'), 'utf8'), /^-- Scrubs/);
});
