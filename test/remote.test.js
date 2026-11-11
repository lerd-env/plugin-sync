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
