#!/usr/bin/env bash
# Push the working tree to the server (https://bi.example.com): upload source, rebuild the Docker image there.
#   deploy/deploy.sh
# First-time server setup (宝塔 site, certificate, .env) is in deploy/README.md.
#
# The server runs the Docker Compose deployment behind an existing nginx (deploy/docker/README.md). We send a
# small source tarball and build the image on the server instead of pulling the repo there; the app container
# runs `app.cli setup` itself when it starts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@203.0.113.10}"
SSH_KEY="${DEPLOY_KEY:-$HOME/.ssh/deploy_key}"
SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$HOST")

echo "==> upload source to $HOST:/opt/bi"
# Tracked + new files of the working tree; never local secrets or business data.
(cd "$ROOT" && git ls-files -z -co --exclude-standard -- . ':!datademo' ':!data' ':!.env*' ':!**/.env') \
  | tar -C "$ROOT" -czf - --null -T - \
  | "${SSH[@]}" 'set -e; rm -rf /opt/bi/.src-new; mkdir -p /opt/bi/.src-new; tar -xzf - -C /opt/bi/.src-new'
# Replace the code but keep the server's .env and build log; the data lives in Docker volumes.
"${SSH[@]}" 'set -e; rsync -a --delete --exclude /.env --exclude /build.log --exclude /.src-new /opt/bi/.src-new/ /opt/bi/; rm -rf /opt/bi/.src-new'

echo "==> rebuild image + restart (a few minutes when dependencies change)"
"${SSH[@]}" bash -s <<'EOF'
set -euo pipefail
cd /opt/bi
old=$(docker image inspect -f '{{.Id}}' bi-app:latest 2>/dev/null || true)
docker compose -f compose.yaml -f deploy/docker/compose.behind-proxy.yaml up -d --build > build.log 2>&1 \
  || { tail -30 build.log; exit 1; }
for _ in $(seq 30); do
  curl -sf http://127.0.0.1:8100/api/health >/dev/null && break
  sleep 2
done
curl -sf http://127.0.0.1:8100/api/health && echo " <- health ok"
# The disk there is tight: drop the image this build replaced (only ours, nothing else on the server).
new=$(docker image inspect -f '{{.Id}}' bi-app:latest)
[ -n "$old" ] && [ "$old" != "$new" ] && docker rmi "$old" >/dev/null 2>&1 || true
EOF
echo "==> done: https://bi.example.com"
