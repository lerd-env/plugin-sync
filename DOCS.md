# remote-pull

Brings a site's database and uploaded files down from its server over SSH, with an optional SQL step that scrubs personal data.

## Set up a site once

Inside the project:

```bash
lerd remote-pull:setup --ssh forge@203.0.113.10 --path /home/forge/shop.com \
  --files storage/app/public --sanitize .lerd/sanitize.sql
```

| Option | Meaning |
|---|---|
| `--ssh user@host`, `--ssh-port` | The server |
| `--path` | The project's folder on the server |
| `--files a,b` | Folders inside the project to copy down |
| `--sanitize file.sql` | SQL in the project to run over the pulled database |
| `--database`, `--db-user`, `--db-password`, `--db-host`, `--db-port` | Only when the server's `.env` does not carry `DB_DATABASE` and friends |

SSH never prompts: your key must be loaded in an agent or have no passphrase, and the server must be in `known_hosts` already, so connect once with `ssh` first.

## Pull

| Where | How |
|---|---|
| Terminal | `lerd remote-pull:pull`, `--db-only` or `--files-only` |
| Dashboard | the site's Commands menu, **Pull from server** |
| AI assistant | `remote-pull_pull` |

The pull replaces the site's local database after a `before-remote-pull` snapshot, which `lerd db:restore` brings back. A failed dump stops before anything local changes. Files are added and updated, never deleted locally.

## Sanitize

A sanitize file is plain SQL committed to the project, for example:

```sql
UPDATE users SET email = CONCAT('user', id, '@example.test'), name = CONCAT('Customer ', id);
TRUNCATE sessions;
```

It stops at the first failing statement and fails the pull, warning that the data may still be unscrubbed.
