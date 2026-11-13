const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

// A WordPress site with a production server, run against a stand-in lerd that
// logs every call, a stand-in ssh that returns a dump and a stand-in lerd API.
// wp says how much of wp-cli the stand-in lerd has: none, as lerd 1.38 for a
// site without its own wp-cli, version only, or all of it.
async function run(script, args, wp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-wp-'));
  const site = path.join(root, 'site');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'lerd.log');
  fs.mkdirSync(site);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(site, 'scrub.sql'), "UPDATE wp_users SET user_email = 'x';\n");
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "CREATE TABLE wp_options (id int);"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'lerd'), `#!/bin/sh
echo "$*" >> ${log}
cat > /dev/null
case "$1 $2" in
  "wp --version") [ ${wp} != none ] ;;
  "wp search-replace") [ ${wp} = all ] ;;
esac
`, { mode: 0o755 });
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'sites'), { recursive: true });
  fs.writeFileSync(path.join(data, 'sites', 'blog.json'), JSON.stringify({ environments: { production: {
    ssh: 'u@h', path: '/srv/blog', url: 'https://blog.example', database: 'blog', db_user: 'u', sanitize: 'scrub.sql', files: [],
  } } }));
  const server = http.createServer((_, res) => res.end(JSON.stringify([
    { name: 'blog', path: site, framework: 'wordpress', domain: 'blog.test', tls: false, services: ['mysql'], db_database: 'blog' },
  ])));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LERD_BIN: path.join(bin, 'lerd'), LERD_PLUGIN_DATA: data, LERD_API_URL: `http://127.0.0.1:${server.address().port}`, LERD_API_TOKEN: 't' };
  try {
    const result = await new Promise((resolve) => execFile(path.join(__dirname, '..', 'bin', script), args, { env }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr })));
    return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  } finally {
    server.close();
  }
}

test('pull refuses a WordPress site lerd has no wp-cli for before importing anything', async () => {
  const r = await run('pull', ['blog', '--db-only'], 'none');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /wp-cli/);
  assert.match(r.stderr, /1\.39/);
  assert.doesNotMatch(r.calls, /db:import/);
});

test('pull still sanitizes when the address rewrite fails after the import', async () => {
  const r = await run('pull', ['blog', '--db-only'], 'version');
  assert.notEqual(r.code, 0);
  assert.match(r.calls, /db:import/);
  assert.match(r.calls, /db:shell/);
});

test('pull imports, sanitizes and rewrites when wp-cli works', async () => {
  const r = await run('pull', ['blog', '--db-only'], 'all');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.calls, /wp search-replace https:\/\/blog\.example http:\/\/blog\.test/);
  assert.match(r.calls, /db:shell/);
});

test('push refuses a WordPress site lerd has no wp-cli for before exporting anything', async () => {
  const r = await run('push', ['blog', '--env', 'production', '--db', '--yes'], 'none');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /1\.39/);
  assert.doesNotMatch(r.calls, /search-replace|db:export/);
});
