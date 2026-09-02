# ops

Copies of what is deployed on the VPS (`148.230.66.88`), kept here so the
server is reproducible from the repo. Editing a file here does nothing on its
own — copy it to the box and reload the service.

| File | Deployed to |
| --- | --- |
| `nginx-pets24x7.com.conf` | `/etc/nginx/sites-available/pets24x7.com` |
| `nginx-api.pets24x7.com.conf` | `/etc/nginx/sites-available/api.pets24x7.com` |
| `nginx-pets24x7-security.conf` | `/etc/nginx/snippets/pets24x7-security.conf` |
| `pets24x7-backup.sh` | `/usr/local/bin/pets24x7-backup.sh` (mode 700) |
| `pets24x7-backup.service` | `/etc/systemd/system/` |
| `pets24x7-backup.timer` | `/etc/systemd/system/` |

The api vhost is certbot-managed: it rewrites the `listen 443` and certificate
lines on renewal, so re-copy from the server rather than the other way around.

Backups land in `/var/backups/pets24x7`, gzipped, mode 600, 14-day retention.
They live on the same disk as the database, so they survive a bad migration,
not a dead server. Ship them off-box before that matters.

Full deploy steps are in `../DEPLOY.md`.
