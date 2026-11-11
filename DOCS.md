# remote-pull

Brings a site's database and uploaded files down from its servers over SSH, or sends them back up, with an optional SQL step that scrubs personal data. Each server is an environment, such as production or staging.

## Set up a site once

Inside the project, once per environment:

```bash
lerd remote-pull:setup --env production --ssh forge@203.0.113.10 --path /home/forge/shop.com \
  --files storage/app/public --sanitize .lerd/sanitize.sql
lerd remote-pull:setup --env staging --ssh forge@203.0.113.11 --path /home/forge/staging.shop.com
```

| Option | Meaning |
|---|---|
| `--env name` | The environment to save, `production` when left out |
| `--ssh user@host`, `--ssh-port` | The server |
| `--path` | The project's folder on the server |
| `--url https://shop.com` | WordPress only: the server's address, swapped for the local one on a pull and back on a push |
| `--files a,b` | Folders inside the project to copy down and send up |
| `--sanitize file.sql` | SQL in the project to run over the pulled database |
| `--database`, `--db-user`, `--db-password`, `--db-host`, `--db-port` | Only when the server's `.env` or `wp-config.php` does not carry the database settings |

`lerd remote-pull:setup` with no options lists the environments, and `--env staging --remove` forgets one.

SSH never prompts: your key must be loaded in an agent or have no passphrase, and the server must be in `known_hosts` already, so connect once with `ssh` first.

## Pull

| Where | How |
|---|---|
| Terminal | `lerd remote-pull:pull`, `--env staging`, `--db-only` or `--files-only` |
| Dashboard | the site's Commands menu, **Pull from server** |
| AI assistant | `remote-pull_pull` |

The pull replaces the site's local database after a `before-remote-pull` snapshot, which `lerd db:restore` brings back. A failed dump stops before anything local changes. Files are added and updated, never deleted locally. With more than one environment, name the one to pull from.

## Push

```bash
lerd remote-pull:push --env staging --dry-run   # what the folders would send
lerd remote-pull:push --env staging             # send the folders
lerd remote-pull:push --env staging --db        # replace the server's database too
```

A push always names its environment. Folders are added and updated on the server, never deleted there, and a `.env` or `wp-config.php` inside them is never sent. A database push asks you to type the environment's name, or takes `--yes`. It works for MySQL and MariaDB: the dump is uploaded and checked, the server's database is backed up to `~/.lerd-remote-pull/` on the server, then imported, and the backup goes back in if the import fails. With `--url` set, WordPress addresses are rewritten in the dump, serialized data included, without touching the local database. Assistants can pull but never push.

## Sanitize

A sanitize file is plain SQL committed to the project, for example:

```sql
UPDATE users SET email = CONCAT('user', id, '@example.test'), name = CONCAT('Customer ', id);
TRUNCATE sessions;
```

It stops at the first failing statement and fails the pull, warning that the data may still be unscrubbed.
