// Small helpers over what lerd hands every plugin process: its API and its CLI.
const { spawnSync } = require('node:child_process');

async function api(path) {
  const res = await fetch(process.env.LERD_API_URL + path, {
    headers: { 'X-Lerd-Plugin-Token': process.env.LERD_API_TOKEN },
  });
  if (!res.ok) throw new Error(`lerd API ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function site(name) {
  const sites = await api('/api/sites');
  const found = sites.find((s) => s.name === name);
  if (!found) throw new Error(`no lerd site named ${name}`);
  return found;
}

// Runs a lerd command in a site's folder, its output going to ours so the
// terminal or the dashboard's run modal shows lerd's own progress lines.
function lerd(args, cwd) {
  const r = spawnSync(process.env.LERD_BIN, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`lerd ${args.join(' ')} failed`);
}

// Same, feeding input on stdin, for lerd db:shell.
function lerdWithInput(args, cwd, input) {
  const r = spawnSync(process.env.LERD_BIN, args, { cwd, input, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`lerd ${args.join(' ')} failed`);
}

// lerd knows a site's database from its .env; a WordPress site keeps it in
// wp-config.php instead.
function siteDatabase(site) {
  if (site.db_database) return site.db_database;
  const fs = require('node:fs');
  const path = require('node:path');
  const { parseWpConfig } = require('./remote');
  try {
    const name = parseWpConfig(fs.readFileSync(path.join(site.path, 'wp-config.php'), 'utf8')).database;
    if (name) return name;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  throw new Error(`lerd does not know ${site.name}'s database name`);
}

// Address rewriting runs wp search-replace, so it is offered only where
// lerd's framework definition is WordPress or Bedrock, which both carry wp-cli.
function isWordPress(site) {
  return ['wordpress', 'bedrock'].includes(site.framework);
}

// lerd wp needs lerd 1.39, or wp-cli in the project's own vendor/bin. Checked
// before anything is touched, so a missing wp-cli never leaves half a sync.
function assertWpCli(site) {
  const r = spawnSync(process.env.LERD_BIN, ['wp', '--version'], { cwd: site.path, stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`rewriting ${site.name}'s addresses needs wp-cli, which this lerd cannot run; update lerd to 1.39, or add it to the project with lerd composer require wp-cli/wp-cli-bundle. Nothing was changed`);
}

function siteUrl(site) {
  return `${site.tls ? 'https' : 'http'}://${site.domain}`;
}

// lerd.diff and lerd.view first ship in 1.39.0; 1.39.0-beta.2 was cut before
// them. A development build (git describe suffix, or dirty) is taken to have them.
function viewerSupported(version) {
  const m = String(version).match(/(\d+)\.(\d+)\.(\d+)(-beta\.(\d+))?(-\d+-g[0-9a-f]+)?(-dirty)?/);
  if (!m) return false;
  const [maj, min, patch] = [+m[1], +m[2], +m[3]];
  if (maj !== 1) return maj > 1;
  if (min !== 39) return min > 39;
  if (patch > 0 || !m[4]) return true;
  return +m[5] >= 3 || !!m[6] || !!m[7];
}

// The running lerd's version string, read once per process.
let versionCache;
function lerdVersion() {
  if (versionCache === undefined) {
    const r = require('node:child_process').spawnSync(process.env.LERD_BIN, ['--version'], { encoding: 'utf8' });
    versionCache = r.status === 0 ? r.stdout.trim() : '';
  }
  return versionCache;
}

module.exports = { api, site, lerd, lerdWithInput, siteDatabase, siteUrl, isWordPress, assertWpCli, viewerSupported, lerdVersion };
