# Deploying new code

1. **On Windows**: commit and push your changes to `main`.
2. **On the Pi** (`ssh gatekeeper@192.168.178.37`):
   ```bash
   cd ~/docker/festival_recap
   bash deploy/update-pi.sh
   ```
   This pulls the latest code and rebuilds/restarts the container **only if**
   app files changed (migrations run automatically on startup). If nothing
   changed, it just tells you so and exits.

Force a rebuild even when it thinks nothing changed (e.g. after only
`music/`, `.env`, or a Dockerfile base-image update):
```bash
bash deploy/update-pi.sh --force-rebuild
```

If `caddy/festival_recap.caddy` changed, the script warns you — re-apply the
block to the Pi Caddyfile and reload Caddy manually:
```bash
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Check it's healthy / see logs:
```bash
docker compose ps
docker compose logs -f festival_recap
```
