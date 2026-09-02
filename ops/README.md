# ops

Copies of what is deployed on the VPS (`148.230.66.88`), kept here so the
server is reproducible from the repo.

`pets24x7-deploy.sh` and the systemd units now install themselves: a deploy
that carries a change to them reinstalls the copy under `/usr/local/bin` or
`/etc/systemd/system` and, for the deploy script, re-executes so the change
applies on the same run that delivers it. The nginx configs do **not**
auto-install — the api vhost is certbot-managed and installing the repo copy
would revert the TLS lines — so a deploy only prints a warning and leaves them
to you.

| File | Deployed to |
| --- | --- |
| `nginx-pets24x7.com.conf` | `/etc/nginx/sites-available/pets24x7.com` |
| `nginx-api.pets24x7.com.conf` | `/etc/nginx/sites-available/api.pets24x7.com` |
| `nginx-pets24x7-security.conf` | `/etc/nginx/snippets/pets24x7-security.conf` |
| `pets24x7-backup.sh` | `/usr/local/bin/pets24x7-backup.sh` (mode 700) |
| `pets24x7-backup.service` | `/etc/systemd/system/` |
| `pets24x7-backup.timer` | `/etc/systemd/system/` |
| `pets24x7-deploy.sh` | `/usr/local/bin/pets24x7-deploy.sh` (mode 700) |
| `pets24x7-deploy.service` | `/etc/systemd/system/` |
| `pets24x7-deploy.timer` | `/etc/systemd/system/` |

The api vhost is certbot-managed: it rewrites the `listen 443` and certificate
lines on renewal, so re-copy from the server rather than the other way around.

Backups land in `/var/backups/pets24x7`, gzipped, mode 600, 14-day retention.
They live on the same disk as the database, so they survive a bad migration,
not a dead server. Ship them off-box before that matters.

## Auto-deploy

Two things start a deploy, and they do the same work:

- `pets24x7-deploy.timer` polls GitHub every 2 minutes. This is the backstop
  and the source of truth — it needs no credentials and no inbound access.
- `.github/workflows/deploy.yml` SSHes in on every push to `main` and starts
  `pets24x7-deploy.service` immediately, trading a dedicated deploy key for
  removing the polling delay. Optional: delete the workflow and the timer still
  covers everything, two minutes later.

The rollout itself rebuilds the API only when `pets24x7_api/`
changed and re-renders the site only when `pets24x7_new/` changed, since a full
render is ~36k files.

`/opt/pets24x7/app` is a clone of the deploy branch. `.env`, `node_modules` and `dist`
are gitignored, so a checkout never touches them. `schema.prisma` is rewritten
to the MySQL provider on every API build, because the repo targets Postgres for
local development.

The static site is served through a symlink:

```
/var/www/pets24x7 -> /var/www/pets24x7-releases/<short-rev>/
```

Each deploy renders into a fresh release directory and swaps the symlink, so
the live site never serves a half-built tree. The previous release is kept, so
a rollback is one `ln -sfn` away:

```bash
ls -1dt /var/www/pets24x7-releases/*/          # newest first
ln -sfn /var/www/pets24x7-releases/<rev> /var/www/pets24x7.tmp
mv -Tf /var/www/pets24x7.tmp /var/www/pets24x7
```

Watch a deploy with `journalctl -u pets24x7-deploy.service -f`, or force one
with `systemctl start pets24x7-deploy.service`.

To deploy from a different branch, change `BRANCH` at the top of the script and
run `git remote set-branches origin <branch>` in `/opt/pets24x7/app`.

Full deploy steps are in `../DEPLOY.md`.
