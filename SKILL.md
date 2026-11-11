---
name: lerd-sync
description: Bring a lerd site's database and uploaded files down from its production or staging server over SSH.
---

`sync_pull` replaces the site's local database with a dump from its server and syncs the folders the user listed. It saves a `before-sync-pull` snapshot first, which `db` `restore` brings back. Ask before running it, since the local data is replaced.

A site has to be set up once by the user with `lerd sync:setup --ssh user@host --path /remote/project`, adding `--files storage/app/public` for uploads and `--sanitize <file.sql>` for SQL that scrubs personal data after the import. When the tool says a site has no server, tell the user that command; never guess hosts or credentials. SSH has to work without a prompt, with a key or an agent.

Pass `what: db` or `what: files` to pull only one of them. A site with several environments (production, staging) needs `env`. Pushing to a server is not offered here: when the user asks, tell them `lerd sync:push --env <name>` and let them run it.
