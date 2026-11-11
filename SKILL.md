---
name: lerd-remote-pull
description: Bring a lerd site's database and uploaded files down from its production or staging server over SSH.
---

`remote-pull_pull` replaces the site's local database with a dump from its server and syncs the folders the user listed. It saves a `before-remote-pull` snapshot first, which `db` `restore` brings back. Ask before running it, since the local data is replaced.

A site has to be set up once by the user with `lerd remote-pull:setup --ssh user@host --path /remote/project`, adding `--files storage/app/public` for uploads and `--sanitize <file.sql>` for SQL that scrubs personal data after the import. When the tool says a site has no server, tell the user that command; never guess hosts or credentials. SSH has to work without a prompt, with a key or an agent.

Pass `what: db` or `what: files` to pull only one of them.
