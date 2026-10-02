#!/bin/sh
# Run from the provisioning-server directory (for example, with host cron).
set -eu
cd "$(dirname "$0")"
docker compose run --rm --no-deps certbot renew --quiet
docker compose exec -T nginx nginx -t
docker compose exec -T nginx nginx -s reload
