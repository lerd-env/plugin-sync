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

test('dumpCommand passes the password in the environment, not argv', () => {
  const cmd = dumpCommand('mysql', { database: 'shop', db_user: 'forge', db_password: 'pw' });
  assert.match(cmd, /MYSQL_PWD='pw' "\$bin" -h '127.0.0.1' -P '3306' -u 'forge' --single-transaction/);
  assert.match(cmd, /'shop'$/);
  assert.match(dumpCommand('postgres', { database: 'shop' }), /^pg_dump -h '127.0.0.1' -p '5432' -U 'postgres' .* -d 'shop'$/);
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
  fs.writeFileSync(path.join(bin, 'mysqldump'), '#!/bin/sh\necho "-- backup of $*"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'mysql'), `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n---\\n' "$input" >> "${dir}/fed"\ncase "$input" in *BAD*) exit 1;; esac\n`, { mode: 0o755 });
  const upload = path.join(dir, 'push.sql');
  fs.writeFileSync(upload, sql);
  const script = pushScript({ database: 'shop', db_user: 'forge', db_password: 'pw' }, upload, path.join(dir, 'backup.sql'), size ?? Buffer.byteLength(sql));
  const r = require('node:child_process').spawnSync('sh', ['-c', `umask 022; ${script}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const backupMode = fs.existsSync(path.join(dir, 'backup.sql')) ? fs.statSync(path.join(dir, 'backup.sql')).mode & 0o777 : null;
  return { status: r.status, stderr: String(r.stderr), fed: read('fed'), backup: read('backup.sql'), backupMode, uploadLeft: fs.existsSync(upload) };
}

test('pushScript backs up, then imports with a session header, and removes the upload', () => {
  const r = runPush('CREATE TABLE t (d datetime DEFAULT \'0000-00-00 00:00:00\');\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.backup, /-- backup of .*'shop'|-- backup of .*shop/);
  assert.match(r.fed, /SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'[\s\S]*CREATE TABLE t/);
  assert.equal(r.uploadLeft, false);
  assert.equal(r.backupMode, 0o600, 'the backup holds the whole database, so only its owner reads it');
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
