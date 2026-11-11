// The default SQL that scrubs personal data from a pulled database, per
// framework, written into the project once the user turns scrubbing on.
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// WordPress names its tables with a prefix from wp-config.php, Bedrock from
// .env. It is pasted into SQL, so only a plain identifier is accepted.
function tablePrefix(sitePath, framework) {
  const m = framework === 'bedrock'
    ? read(path.join(sitePath, '.env')).match(/^\s*DB_PREFIX\s*=\s*["']?([^"'\s]*)/m)
    : read(path.join(sitePath, 'wp-config.php')).match(/\$table_prefix\s*=\s*(["'])(.*?)\1/);
  const prefix = (framework === 'bedrock' ? m?.[1] : m?.[2]) || 'wp_';
  if (!/^[A-Za-z0-9_]+$/.test(prefix)) throw new Error(`the table prefix ${prefix} is not a plain name, so no default scrub is written`);
  return prefix;
}

const WORDPRESS = `-- Scrubs personal data from the database a pull brings down, run on this
-- site's copy only. Logins and passwords stay, so you can still sign in.
-- Edit freely; a failing statement fails the pull.

UPDATE {prefix}users SET user_email = CONCAT('user', ID, '@example.test'), user_url = '', display_name = CONCAT('User ', ID), user_nicename = CONCAT('user-', ID);
UPDATE {prefix}usermeta SET meta_value = '' WHERE meta_key IN ('first_name', 'last_name', 'nickname', 'description', 'billing_first_name', 'billing_last_name', 'billing_company', 'billing_address_1', 'billing_address_2', 'billing_city', 'billing_postcode', 'billing_state', 'billing_phone', 'billing_email', 'shipping_first_name', 'shipping_last_name', 'shipping_company', 'shipping_address_1', 'shipping_address_2', 'shipping_city', 'shipping_postcode', 'shipping_state', 'shipping_phone');
DELETE FROM {prefix}usermeta WHERE meta_key = 'session_tokens';
UPDATE {prefix}comments SET comment_author = CONCAT('Commenter ', comment_ID), comment_author_email = CONCAT('comment', comment_ID, '@example.test'), comment_author_url = '', comment_author_IP = '127.0.0.1', comment_agent = '';

-- WooCommerce keeps order addresses in post meta, which every site has.
UPDATE {prefix}postmeta SET meta_value = '' WHERE meta_key IN ('_billing_first_name', '_billing_last_name', '_billing_company', '_billing_address_1', '_billing_address_2', '_billing_city', '_billing_postcode', '_billing_phone', '_billing_email', '_shipping_first_name', '_shipping_last_name', '_shipping_company', '_shipping_address_1', '_shipping_address_2', '_shipping_city', '_shipping_postcode', '_shipping_phone', '_customer_ip_address', '_customer_user_agent');

-- With WooCommerce's order tables (HPOS) on, uncomment these too:
-- UPDATE {prefix}wc_orders SET billing_email = CONCAT('order', id, '@example.test'), ip_address = '127.0.0.1', user_agent = '';
-- UPDATE {prefix}wc_order_addresses SET first_name = 'Customer', last_name = CONCAT(id), company = '', address_1 = '', address_2 = '', city = '', postcode = '', phone = '', email = CONCAT('address', id, '@example.test');
-- DELETE FROM {prefix}woocommerce_sessions;
`;

const LARAVEL = `-- Scrubs personal data from the database a pull brings down, run on this
-- site's copy only. Passwords stay, so you sign in as user<id>@example.test.
-- Edit freely; a failing statement fails the pull.

UPDATE users SET email = CONCAT('user', id, '@example.test'), name = CONCAT('User ', id);

-- Uncomment what your app has:
-- DELETE FROM sessions;
-- DELETE FROM password_reset_tokens;
-- DELETE FROM personal_access_tokens;
`;

const GENERIC = `-- Scrubs personal data from the database a pull brings down, run on this
-- site's copy only. A failing statement fails the pull. For example:
-- UPDATE users SET email = CONCAT('user', id, '@example.test'), name = CONCAT('User ', id);
-- DELETE FROM sessions;
`;

function scrubTemplate(framework, prefix) {
  if (framework === 'wordpress' || framework === 'bedrock') return WORDPRESS.replaceAll('{prefix}', prefix);
  if (framework === 'laravel') return LARAVEL;
  return GENERIC;
}

const DEFAULT_FILE = '.lerd/scrub.sql';
const MAX = 1024 * 1024;

// The scrub file of an environment, checked to stay inside the project.
function scrubFile(env, sitePath) {
  const { checkRelative } = require('./remote');
  const rel = checkRelative(env.sanitize || DEFAULT_FILE);
  return { rel, abs: path.join(sitePath, rel) };
}

const ownFile = (name) => `.lerd/scrub-${name}.sql`;

function scrubInfo(env, sitePath, name = env.name) {
  const { rel, abs } = scrubFile(env, sitePath);
  const exists = fs.existsSync(abs);
  return { enabled: !!env.sanitize, path: rel, exists, content: exists ? fs.readFileSync(abs, 'utf8') : '', own: rel === ownFile(name) };
}

// Turns scrubbing on for one environment. The default is written only when
// there is no file yet, so an edited one is never replaced.
function scrubOn(env, sitePath, framework) {
  const { rel, abs } = scrubFile(env, sitePath);
  if (!fs.existsSync(abs)) {
    const prefix = framework === 'wordpress' || framework === 'bedrock' ? tablePrefix(sitePath, framework) : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, scrubTemplate(framework, prefix));
  }
  env.sanitize = rel;
}

// Points an environment at the shared file or at one of its own. An own file
// starts as a copy of the shared one, or the framework default when there is
// none; an existing file is never replaced either way.
function scrubUseFile(env, sitePath, framework, which, name = env.name) {
  if (which !== 'shared' && which !== 'own') throw new Error(`the scrub file is shared or own, not ${which}`);
  const rel = which === 'own' ? ownFile(name) : DEFAULT_FILE;
  const abs = path.join(sitePath, rel);
  if (which === 'own' && !fs.existsSync(abs)) {
    const shared = path.join(sitePath, DEFAULT_FILE);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(shared)) fs.copyFileSync(shared, abs);
  }
  env.sanitize = rel;
  if (!fs.existsSync(abs)) scrubOn(env, sitePath, framework);
}

// Off keeps the file, so turning it back on picks up the same edits.
function scrubOff(env) {
  delete env.sanitize;
}

function scrubSave(env, sitePath, content) {
  if (typeof content !== 'string') throw new Error('the scrub SQL must be text');
  if (Buffer.byteLength(content) > MAX) throw new Error('the scrub SQL is too large; keep it under 1 MB');
  const { abs } = scrubFile(env, sitePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

module.exports = { tablePrefix, scrubTemplate, scrubInfo, scrubOn, scrubOff, scrubSave, scrubUseFile };
