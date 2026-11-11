const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { parseDbEnv, sh, dumpCommand, checkRelative, mariadbToMysql } = require('../lib/remote');

test('parseDbEnv keeps only the DB keys and unquotes them', () => {
  const env = [
    'APP_KEY=base64:secret',
    'DB_HOST=127.0.0.1',
    'DB_DATABASE="shop"',
    "DB_USERNAME='forge'",
    'DB_PASSWORD="p#ss \\"word\\""',
    'export DB_PORT=3307 # mysql',
    '# DB_DATABASE=commented',
  ].join('\n');
  assert.deepEqual(parseDbEnv(env), { db_host: '127.0.0.1', database: 'shop', db_user: 'forge', db_password: 'p#ss "word"', db_port: '3307' });
});

test('sh quotes anything the remote shell would otherwise read', () => {
  const nasty = `it's $(rm -rf ~); "x"`;
  assert.equal(execFileSync('sh', ['-c', `printf %s ${sh(nasty)}`]).toString(), nasty);
});

// The command line of a process is readable by every user on a shared host,
// so the password reaches the server on ssh's stdin, never in the command.
test('dumpCommand reads the password from stdin, never from its own text', () => {
  const cmd = dumpCommand('mysql', { database: 'shop', db_user: 'forge', db_password: 's3cr3t' });
  assert.ok(!cmd.includes('s3cr3t'));
  assert.match(cmd, /^IFS= read -r MYSQL_PWD; export MYSQL_PWD; /);
  assert.match(cmd, /"\$bin" -h '127.0.0.1' -P '3306' -u 'forge' --single-transaction .* 'shop'$/);
  const pg = dumpCommand('postgres', { database: 'shop', db_password: 's3cr3t' });
  assert.ok(!pg.includes('s3cr3t'));
  assert.match(pg, /^IFS= read -r PGPASSWORD; export PGPASSWORD; pg_dump -h '127.0.0.1' -p '5432' -U 'postgres' .* -d 'shop'$/);
  assert.match(dumpCommand('postgres', { database: 'shop' }), /^pg_dump /, 'no password, nothing to read');
});

test('checkRelative keeps synced folders inside the project', () => {
  assert.equal(checkRelative('storage/app/public/'), 'storage/app/public');
  for (const bad of ['/etc', '../other', 'a/../../b', '']) assert.throws(() => checkRelative(bad));
});

test('mariadbToMysql rewrites only what MySQL refuses', () => {
  assert.equal(mariadbToMysql('COLLATE=utf8mb4_uca1400_ai_ci;'), 'COLLATE=utf8mb4_0900_ai_ci;');
  assert.equal(mariadbToMysql("SET sql_mode = 'NO_AUTO_CREATE_USER,STRICT_TRANS_TABLES'"), "SET sql_mode = 'STRICT_TRANS_TABLES'");
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeConfig, pickEnv, parseWpConfig, mysqlToMariadb, pushScript } = require('../lib/remote');

test('normalizeConfig reads a one-server config as its production environment', () => {
  const flat = { ssh: 'forge@host', path: '/srv/shop', files: ['public/uploads'] };
  assert.deepEqual(normalizeConfig(flat), { environments: { production: flat } });
  assert.deepEqual(normalizeConfig(null), { environments: {} });
  const multi = { environments: { staging: { ssh: 's@h', path: '/s' } } };
  assert.deepEqual(normalizeConfig(multi), multi);
});

test('pickEnv takes the only environment, and asks when there are several', () => {
  const one = { environments: { production: { ssh: 'p@h' } } };
  assert.equal(pickEnv(one).ssh, 'p@h');
  assert.equal(pickEnv(one, 'production').ssh, 'p@h');
  assert.throws(() => pickEnv(one, 'staging'), /no staging environment.*production/);
  assert.throws(() => pickEnv(one, undefined, { required: true }), /--env production/);
  const two = { environments: { production: {}, staging: {} } };
  assert.throws(() => pickEnv(two), /production, staging/);
  assert.throws(() => pickEnv({ environments: {} }), /no server set/);
});

test('parseWpConfig reads the database settings, port split from the host', () => {
  const php = [
    "define( 'DB_NAME', 'shop' );",
    'define("DB_USER", "forge");',
    "define( 'DB_PASSWORD', 'it\\'s' );",
    "define( 'DB_HOST', 'db.internal:3307' );",
    "// define( 'DB_NAME', 'commented' );",
  ].join('\n');
  assert.deepEqual(parseWpConfig(php), { database: 'shop', db_user: 'forge', db_password: "it's", db_host: 'db.internal', db_port: '3307' });
  assert.deepEqual(parseWpConfig("define('DB_HOST', 'localhost');"), { db_host: 'localhost' });
});

test('mysqlToMariadb swaps the MySQL 8 collations MariaDB refuses', () => {
  assert.equal(mysqlToMariadb('COLLATE=utf8mb4_0900_ai_ci;'), 'COLLATE=utf8mb4_unicode_520_ci;');
  assert.equal(mysqlToMariadb('COLLATE utf8mb4_0900_as_cs'), 'COLLATE utf8mb4_unicode_520_ci');
  assert.equal(mysqlToMariadb("'utf8mb4_unicode_ci'"), "'utf8mb4_unicode_ci'");
});

// Runs the server-side push script against fake mysql and mysqldump binaries:
// mysqldump prints a backup, mysql records what it was fed and fails on BAD.
function runPush(sql, { size } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-push-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'mysqldump'), `#!/bin/sh\necho "-- backup of $*"\necho "$MYSQL_PWD" >> "${dir}/pwd"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'mysql'), `#!/bin/sh\necho "$MYSQL_PWD" >> "${dir}/pwd"\ninput=$(cat)\nprintf '%s\\n---\\n' "$input" >> "${dir}/fed"\ncase "$input" in *BAD*) exit 1;; esac\n`, { mode: 0o755 });
  const upload = path.join(dir, 'push.sql');
  fs.writeFileSync(upload, sql);
  const script = pushScript({ database: 'shop', db_user: 'forge', db_password: 's3cr3t' }, upload, path.join(dir, 'backup.sql'), size ?? Buffer.byteLength(sql));
  assert.ok(!script.includes('s3cr3t'), 'the password must not be in the server command');
  const r = require('node:child_process').spawnSync('sh', ['-c', `umask 022; ${script}`], { input: 's3cr3t\n', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const backupMode = fs.existsSync(path.join(dir, 'backup.sql')) ? fs.statSync(path.join(dir, 'backup.sql')).mode & 0o777 : null;
  return { status: r.status, stderr: String(r.stderr), fed: read('fed'), pwd: read('pwd'), backup: read('backup.sql'), backupMode, uploadLeft: fs.existsSync(upload) };
}

test('pushScript backs up, then imports with a session header, and removes the upload', () => {
  const r = runPush('CREATE TABLE t (d datetime DEFAULT \'0000-00-00 00:00:00\');\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.backup, /-- backup of .*'shop'|-- backup of .*shop/);
  assert.match(r.fed, /SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'[\s\S]*CREATE TABLE t/);
  assert.equal(r.uploadLeft, false);
  assert.equal(r.backupMode, 0o600, 'the backup holds the whole database, so only its owner reads it');
  assert.deepEqual([...new Set(r.pwd.trim().split('\n'))], ['s3cr3t'], 'mysqldump and mysql still get the password');
});

test('pushScript restores the backup when the import fails', () => {
  const r = runPush('BAD SQL;\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /import failed/);
  const feeds = r.fed.split('---\n').filter(Boolean);
  assert.equal(feeds.length, 2);
  assert.match(feeds[1], /-- backup of/);
});

test('pushScript refuses an upload that arrived short, before touching the database', () => {
  const r = runPush('SELECT 1;\n', { size: 999 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /upload/);
  assert.equal(r.fed, '');
  assert.equal(r.backup, '');
});

const { applyEnv, publicConfig } = require('../lib/remote');

test('applyEnv merges fields into one environment and checks them', () => {
  const config = { environments: { production: { ssh: 'p@h', path: '/p', db_password: 'old' } } };
  applyEnv(config, 'production', { url: 'https://shop.com/', files: 'wp-content/uploads, public/media', db_password: '' });
  assert.deepEqual(config.environments.production, { ssh: 'p@h', path: '/p', db_password: 'old', url: 'https://shop.com', files: ['wp-content/uploads', 'public/media'] });
  applyEnv(config, 'staging', { ssh: 's@h', path: '/s', ssh_port: '2222' });
  assert.deepEqual(Object.keys(config.environments), ['production', 'staging']);
  applyEnv(config, 'staging', { ssh_port: '' });
  assert.equal(config.environments.staging.ssh_port, undefined, 'an emptied field is dropped');
});

test('applyEnv refuses what would point outside the project or nowhere', () => {
  const fresh = () => ({ environments: {} });
  assert.throws(() => applyEnv(fresh(), 'Prod', { ssh: 'a@b', path: '/p' }), /not a valid environment name/);
  assert.throws(() => applyEnv(fresh(), 'prod', { ssh: 'a@b' }), /--ssh user@host and --path/);
  assert.throws(() => applyEnv(fresh(), 'prod', { ssh: 'a@b', path: '/p', files: '../etc' }), /inside the project/);
  assert.throws(() => applyEnv(fresh(), 'prod', { ssh: 'a@b', path: '/p', url: 'shop.com' }), /site's address/);
  assert.throws(() => applyEnv(fresh(), 'prod', { ssh: '-oProxyCommand=x', path: '/p' }), /user@host/);
  assert.throws(() => applyEnv(fresh(), 'prod', { ssh: 'a@b', path: '/p', bogus: 1 }), /unknown setting bogus/);
});

test('publicConfig never hands the database password to the page', () => {
  const out = publicConfig({ environments: { production: { ssh: 'p@h', db_password: 'secret' }, staging: { ssh: 's@h' } } });
  assert.deepEqual(out, { environments: { production: { ssh: 'p@h', db_password_set: true }, staging: { ssh: 's@h', db_password_set: false } } });
});

test('applyEnv keeps backups on unless the user turns them off', () => {
  const config = { environments: {} };
  applyEnv(config, 'prod', { ssh: 'a@b', path: '/p' });
  assert.equal(config.environments.prod.backup, undefined, 'on by default, so nothing is stored');
  applyEnv(config, 'prod', { backup: 'off' });
  assert.equal(config.environments.prod.backup, false);
  applyEnv(config, 'prod', { backup: true });
  assert.equal(config.environments.prod.backup, undefined);
  assert.throws(() => applyEnv(config, 'prod', { backup: 'maybe' }), /on or off/);
});

test('applyEnv takes how many backups to keep, 10 when unset', () => {
  const config = { environments: {} };
  applyEnv(config, 'prod', { ssh: 'a@b', path: '/p', keep: '25' });
  assert.equal(config.environments.prod.keep, 25);
  applyEnv(config, 'prod', { keep: '' });
  assert.equal(config.environments.prod.keep, undefined);
  for (const bad of ['0', '-3', 'many', '1.5']) assert.throws(() => applyEnv(config, 'prod', { keep: bad }), /whole number/);
});

const { viewerSupported } = require('../lib/lerd');

test('viewerSupported knows which lerd has lerd.diff and lerd.view', () => {
  const yes = ['1.39.0', '1.39.0-beta.3', '1.39.1', '1.40.0', '2.0.0', 'lerd version 1.39.0 (commit abc)', '1.39.0-beta.2-8-g72849ec2', '1.39.0-beta.2-dirty'];
  const no = ['1.38.4', '1.39.0-beta.2', '1.39.0-beta.1', 'lerd version 1.37.0 (commit abc)', 'nonsense', ''];
  for (const v of yes) assert.equal(viewerSupported(v), true, v);
  for (const v of no) assert.equal(viewerSupported(v), false, v);
});

const { loadConfig, saveConfig } = require('../lib/remote');

test('a site name can never lead a config file out of the data folder', () => {
  process.env.LERD_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-data-'));
  saveConfig('shop-2.test', { environments: {} });
  assert.deepEqual(loadConfig('shop-2.test'), { environments: {} });
  for (const bad of ['../../etc/x', '..', '.hidden', 'a/b', '', 'shop\\x']) {
    assert.throws(() => loadConfig(bad), /not a site name/, bad);
    assert.throws(() => saveConfig(bad, { environments: {} }), /not a site name/, bad);
  }
});
