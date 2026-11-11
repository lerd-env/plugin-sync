// Where a site's server is, what to ask it for, and how to say it over ssh.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ENV_KEYS = { DB_HOST: 'db_host', DB_PORT: 'db_port', DB_DATABASE: 'database', DB_USERNAME: 'db_user', DB_PASSWORD: 'db_password' };

function configFile(site) {
  return path.join(process.env.LERD_PLUGIN_DATA, 'sites', `${site}.json`);
}

// A site's servers, one per environment. A file from before environments held
// a single server, which is read as production.
function normalizeConfig(raw) {
  if (!raw) return { environments: {} };
  if (raw.environments) return raw;
  return { environments: { production: raw } };
}

function loadConfig(site) {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configFile(site), 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return normalizeConfig(null);
    throw e;
  }
}

// The environment to talk to. Pull may leave it out when the site has only
// one; push never may, since writing to the wrong server is not undoable.
function pickEnv(config, name, { required = false } = {}) {
  const names = Object.keys(config.environments);
  if (!names.length) throw new Error('this site has no server set; run lerd remote-pull:setup --ssh user@host --path /remote/project in the project');
  if (name) {
    if (!config.environments[name]) throw new Error(`no ${name} environment; this site has ${names.join(', ')}`);
    return { name, ...config.environments[name] };
  }
  if (required) throw new Error(`name the environment, like --env ${names[0]}`);
  if (names.length > 1) throw new Error(`this site has ${names.join(', ')}; pick one with --env`);
  return { name: names[0], ...config.environments[names[0]] };
}

function saveConfig(site, config) {
  fs.mkdirSync(path.dirname(configFile(site)), { recursive: true });
  fs.writeFileSync(configFile(site), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// The engine a lerd service speaks, from its name: mysql, mariadb and their
// versioned variants are one family, postgres and its variants the other.
function engineOf(service) {
  if (/^(mysql|mariadb)(-|$)/.test(service)) return 'mysql';
  if (/^postgres(-|$)/.test(service)) return 'postgres';
  return null;
}

// Only the DB_* keys are taken from the server's .env; nothing else in it is kept.
function parseDbEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !ENV_KEYS[m[1]]) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[ENV_KEYS[m[1]]] = v;
  }
  return out;
}

// WordPress keeps its database settings in wp-config.php rather than a .env.
const WP_KEYS = { DB_NAME: 'database', DB_USER: 'db_user', DB_PASSWORD: 'db_password', DB_HOST: 'db_host' };
function parseWpConfig(text) {
  const out = {};
  const re = /^\s*define\s*\(\s*(['"])(DB_[A-Z]+)\1\s*,\s*(['"])((?:\\.|(?!\3).)*)\3\s*\)/gm;
  for (const m of text.matchAll(re)) {
    if (WP_KEYS[m[2]]) out[WP_KEYS[m[2]]] = m[4].replace(/\\(.)/g, '$1');
  }
  const hp = out.db_host && out.db_host.match(/^(.*):(\d+)$/);
  if (hp) [out.db_host, out.db_port] = [hp[1], hp[2]];
  return out;
}

// Quotes a value for the remote POSIX shell.
function sh(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// The dump runs on the server with the server's own client, so it matches the
// server's version. Its exit status comes back through ssh, so a failed dump is
// never mistaken for an empty database.
function dumpCommand(engine, db) {
  if (engine === 'mysql') {
    const conn = `-h ${sh(db.db_host || '127.0.0.1')} -P ${sh(db.db_port || '3306')} -u ${sh(db.db_user || 'root')}`;
    const pw = db.db_password ? `MYSQL_PWD=${sh(db.db_password)} ` : '';
    return `bin=$(command -v mysqldump || command -v mariadb-dump) || { echo 'no mysqldump on the server' >&2; exit 127; }; ${pw}"$bin" ${conn} --single-transaction --routines --triggers --no-tablespaces ${sh(db.database)}`;
  }
  const conn = `-h ${sh(db.db_host || '127.0.0.1')} -p ${sh(db.db_port || '5432')} -U ${sh(db.db_user || 'postgres')}`;
  const pw = db.db_password ? `PGPASSWORD=${sh(db.db_password)} ` : '';
  return `${pw}pg_dump ${conn} --no-owner --no-privileges -d ${sh(db.database)}`;
}

// BatchMode keeps ssh from waiting on a password prompt nobody can answer
// from the dashboard or an assistant; a key or an agent has to do it.
function sshArgs(config) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
  if (config.ssh_port) args.push('-p', String(config.ssh_port));
  return args;
}

function ssh(config, command, stdout) {
  const r = spawnSync('ssh', ['-C', ...sshArgs(config), config.ssh, command], {
    stdio: ['ignore', stdout ?? 'pipe', 'pipe'],
    maxBuffer: 16 << 20,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`ssh ${config.ssh}: ${String(r.stderr).trim() || 'exit ' + r.status}`);
  return String(r.stdout ?? '');
}

// The connection on the server: what setup saved, filled in from the server's
// .env, or its wp-config.php, for anything it left out.
function remoteDatabase(config) {
  const saved = Object.fromEntries(Object.values(ENV_KEYS).filter((k) => config[k]).map((k) => [k, config[k]]));
  if (saved.database && saved.db_user) return saved;
  const env = ssh(config, `cat ${sh(config.path + '/.env')} 2>/dev/null || true`);
  let found = parseDbEnv(env);
  if (!found.database) found = parseWpConfig(ssh(config, `cat ${sh(config.path + '/wp-config.php')} 2>/dev/null || true`));
  const db = { ...found, ...saved };
  if (!db.database) throw new Error(`no DB_DATABASE in ${config.path}/.env or DB_NAME in its wp-config.php on the server; set it with lerd remote-pull:setup --database <name> --db-user <user>`);
  return db;
}

function mysqlConn(db) {
  const pw = db.db_password ? `MYSQL_PWD=${sh(db.db_password)} ` : '';
  return { pw, conn: `-h ${sh(db.db_host || '127.0.0.1')} -P ${sh(db.db_port || '3306')} -u ${sh(db.db_user || 'root')}` };
}

// Dumps such as wp-cli's carry no session header, and a strict server refuses
// WordPress's zero dates without the sql_mode mysqldump would have set.
const IMPORT_HEADER = "SET NAMES utf8mb4; SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'; SET FOREIGN_KEY_CHECKS=0;";

// Runs on the server once the dump is uploaded: check it arrived whole, back the
// database up, import, and put the backup back if the import fails part way.
function pushScript(db, upload, backup, size) {
  const { pw, conn } = mysqlConn(db);
  const name = sh(db.database);
  return [
    `umask 077; f=${sh(upload)}; b=${sh(backup)}`,
    `[ "$(wc -c < "$f" | tr -d ' ')" = ${sh(size)} ] || { echo 'the upload arrived incomplete; the server was not changed' >&2; rm -f "$f"; exit 1; }`,
    `dump=$(command -v mysqldump || command -v mariadb-dump) || { echo 'no mysqldump on the server' >&2; rm -f "$f"; exit 127; }`,
    `${pw}"$dump" ${conn} --single-transaction --routines --triggers --no-tablespaces ${name} > "$b" && [ -s "$b" ] || { echo 'the backup failed; the server was not changed' >&2; rm -f "$f"; exit 1; }`,
    `if ! { echo ${sh(IMPORT_HEADER)}; cat "$f"; } | ${pw}mysql ${conn} ${name}; then`,
    `  echo "the import failed; restoring the backup taken just before it" >&2`,
    `  ${pw}mysql ${conn} ${name} < "$b"; rm -f "$f"; exit 1`,
    `fi`,
    `rm -f "$f"; echo "backup kept on the server at $(cd "$(dirname "$b")" && pwd)/$(basename "$b")"`,
  ].join('\n');
}

// A MariaDB dump carries two things MySQL 8 refuses outright: its uca1400
// collations (ERROR 1273) and NO_AUTO_CREATE_USER in a trigger's or routine's
// sql_mode (ERROR 1231). A dump headed for a MySQL service gets MySQL's own.
function mariadbToMysql(line) {
  return line
    .replace(/\butf8mb4_uca1400_\w+/g, 'utf8mb4_0900_ai_ci')
    .replace(/\butf8mb3_uca1400_\w+/g, 'utf8mb3_general_ci')
    .replace(/(sql_mode\s*=\s*'[^']*)/g, (m) => m.replace(/NO_AUTO_CREATE_USER,?|,NO_AUTO_CREATE_USER/g, ''));
}

// The reverse, for a lerd MySQL dump headed for a MariaDB server.
function mysqlToMariadb(line) {
  return line.replace(/\butf8mb4_0900_\w+/g, 'utf8mb4_unicode_520_ci');
}

async function rewriteFile(file, fn) {
  const readline = require('node:readline');
  const tmp = file + '.rewrite';
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (!out.write(fn(line) + '\n')) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(tmp, file);
}

// A synced folder must stay inside the site on both ends.
function checkRelative(dir) {
  if (!dir || path.isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) {
    throw new Error(`${dir} must be a folder inside the project, like storage/app/public`);
  }
  return dir.replace(/\/+$/, '');
}

module.exports = {
  normalizeConfig, loadConfig, saveConfig, pickEnv, parseWpConfig, mysqlConn, pushScript, mysqlToMariadb, engineOf, parseDbEnv, sh, dumpCommand, sshArgs, ssh, remoteDatabase,
  mariadbToMysql, rewriteFile, checkRelative,
};
