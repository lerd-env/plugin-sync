# Sync for Lerd

> Keep a [Lerd](https://lerd.sh) site and its servers in step. Pull the
> production database and uploads down, push files back up, see what differs
> side by side, and get back anything a transfer replaced.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Lerd plugin](https://img.shields.io/badge/lerd-plugin-ff2d20)](https://plugins.lerd.sh)
[![Lerd 1.38+](https://img.shields.io/badge/lerd-1.38%2B-ff2d20)](https://lerd.sh)
[![Reddit](https://img.shields.io/badge/Reddit-r%2Flerd-ff2d20?logo=reddit)](https://reddit.com/r/lerd)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/5JK54s7xCC)

![The Sync tab showing a site and its production server side by side, with the files that differ marked](docs/tab.png)

A local copy is only useful with real data in it, and real work eventually has to go back. This plugin talks to any server you can SSH into, Forge, Ploi, a VPS or a shared host, with one environment per server, such as production and staging. It pulls the database and the folders users upload into, scrubs personal data from the copy if you ask it to, pushes the files you pick, and keeps a backup of everything it replaces on either side.

## Install

```bash
lerd plugin install sync
```

## Use

Save the site's server once, inside the linked project, then pull:

```bash
cd ~/code/shop
lerd sync:setup --env production --ssh forge@203.0.113.10 --path /home/forge/shop.com --files storage/app/public
lerd sync:pull
```

Every site gets a **Sync** tab in the dashboard, with the project as a tree on both sides, badges for what is only on one side or differs, lerd's own diff on a click, and the database and backups below. The site's **Commands** menu gets **Pull from server**, which pulls from production when the site has several environments, and AI assistants get `sync_pull`, `sync_status` and `sync_backups` through Lerd's MCP server; pushing, restoring and removing stay with you. The full instructions are on the plugin's **Documentation** tab in the dashboard.

```bash
lerd sync:status --dir wp-content            # what is only here, only there, or differs
lerd sync:diff wp-content/themes/shop/style.css
lerd sync:push --env production --paths wp-content/themes/shop
lerd sync:push --env production --db         # replace the server's database, after a backup
lerd sync:backups --restore pull:20261111T111800
```

| Option | Meaning |
|---|---|
| `--env` | The environment, such as `production` or `staging`; push always needs it |
| `--ssh user@host`, `--ssh-port` | The server, reached with your own SSH key or agent |
| `--path` | The project's folder on the server |
| `--files a,b` | Folders a plain pull or push copies, such as uploads |
| `--paths a,b` | Just these files and folders, for one pull or push |
| `--url https://shop.com` | WordPress and Bedrock: the server's address, rewritten both ways in the database, with Lerd 1.39 or wp-cli in the project |
| `--scrub on` | Scrub personal data after every pull, starting from a default for the framework |
| `--never a,b` | Names, files or folders never synced, on top of config files, `.lerd/`, `.lerd.yaml` and `.git/` |
| `--keep 10`, `--backup off` | How many backups each side keeps, or none at all |
| `--database`, `--db-user`, `--db-password` | The server's database, when its `.env` or `wp-config.php` does not say it |

SSH runs with `BatchMode=yes`, so it never waits on a prompt: the key must be loaded in an agent or have no passphrase, and the server must already be in your `known_hosts`.

## What it does

- Dumps the database on the server with its own `mysqldump`, `mariadb-dump` or `pg_dump`, and imports it after a `before-sync-pull` snapshot, so `lerd db:restore` undoes a pull. A failed dump stops before anything local changes.
- Swaps collations MySQL and MariaDB refuse from each other, and rewrites a WordPress site's address both ways with `wp search-replace`, serialized data included.
- Runs the scrub SQL in `.lerd/scrub.sql`, or an environment's own file, after a pull, stopping and failing the pull at its first failing statement.
- Pushes a database only after you type the environment's name, uploading the dump, checking its size, backing the server's database up and putting that backup back if the import fails.
- Copies files with `rsync` and never deletes anything on either side. Each side's config (`.env`, `.env.*`, `wp-config.php`, Drupal's `settings.php`), its lerd setup and its `.git/` are never copied, and neither is anything you add to the never sync list.
- Keeps every file a transfer replaces, on the server for a push and on your machine for a pull, and drops the oldest past the number you keep.

## What it reads, changes and sends

On the server it reads the project's `.env` or `wp-config.php` for the database settings (nothing else from them is kept), lists folders with `find`, reads a file with `cat` to show it, and dumps the database. A pull writes nothing there. A push writes the files you send into the project, keeps what they replace under `~/.lerd-sync/files/`, and with `--db` uploads a dump to `~/.lerd-sync/`, imports it and keeps the backup beside it, all readable only by you. The database password reaches the server on ssh's input, never on a command line, so other users of a shared host cannot see it. Locally it reads the site's `wp-config.php` or `.env` only for its database name and, on WordPress and Bedrock, its table prefix, and it writes the site's Lerd database, the files you pull, the scrub file in `.lerd/`, and backups and settings in the plugin's data folder, readable only by you. Nothing is sent anywhere but the server you named.

## Requirements

- Lerd 1.38 or newer, and Node, which Lerd installs; the tab's diff and file viewer need Lerd 1.39, and its scrub editor is a plain text box before that
- `ssh`, `diff` and rsync 3 or newer on this machine; macOS ships an older rsync, so install it with `brew install rsync`
- A Linux server, whose GNU `find` lists folders for the tab, with rsync and the database's dump tool

## Development

```bash
node --test test/
lerd plugin install .
```

## License

MIT
