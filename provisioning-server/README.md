# VoiceHost Provisioning Server

Standalone reference/staging implementation of the VoiceHost endpoint provisioning API. Configuration is **VoiceHost managed only**; the Flutter settings screen no longer offers manual SIP or Janus editing.

This service is intentionally separate from RANDY. It owns activation, device identity, device state and managed endpoint configuration. RANDY remains the mobile telephony runtime.

## Current scope

Implemented client endpoints:

- `POST /api/v1/device/activate`
- `POST /api/v1/device/token/refresh`
- `POST /api/v1/device/check-in`
- `GET /api/v1/device/configuration`
- `POST /api/v1/device/push-tokens`
- `POST /api/v1/device/logout`

Staging administration endpoints:

- `POST /api/v1/admin/activations`
- `GET /api/v1/admin/devices` (paginated; optional state and query filters)\n- `POST /api/v1/admin/maintenance/housekeeping` (dry-run by default)\n- `GET /api/v1/admin/devices/{device_id}`
- `POST /api/v1/admin/devices/{device_id}/state`

The admin-key surface is for development/staging and should be replaced by the VoiceHost portal/SSO authorization model before production.

## Run with Docker

```bash
cp .env.example .env
# Edit PROVISIONING_ADMIN_KEY and set a persistent PROVISIONING_REFRESH_RETRY_KEY.
# Generate the latter once using: python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
# Retain the same key across container restarts and deployments.
docker compose up -d --build
```

Two isolated containers listen on port 8080 internally. Compose binds the public API to `127.0.0.1:8081` and administration to `127.0.0.1:8082`. Both share the SQLite Docker volume.

Health:

```bash
curl http://127.0.0.1:8081/health
```

Swagger:

```text
http://127.0.0.1:8081/docs (device API only)\nhttp://127.0.0.1:8082/docs (administration API only)
```

## Create an activation code

A RANDY-managed test endpoint that relies on existing/manual SIP credentials:

```bash
curl -sS -X POST http://127.0.0.1:8082/api/v1/admin/activations \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Key: change-me' \
  -d '{
    "extension": "1001",
    "display_name": "Simon",
    "connection_strategy": "managed_mobile",
    "telephony_mode": "randy_managed"
  }'
```

The response includes the single-use `code` and a future QR URI.

For the current transitional client, SIP credentials can also be returned:

```json
{
  "extension": "1001",
  "display_name": "Simon",
  "janus_api_secret": "development-only-janus-secret",
  "sip_username": "1001",
  "sip_password": "development-only-secret",
  "sip_realm": "hpbx.sipconvergence.co.uk",
  "sip_proxy": "sip.example.net"
}
```

The app receives `janus_api_secret` from provisioning in `telephony.janus_api_secret`; it is read-only in managed app settings. Because the current test endpoint is plain HTTP, the secret is exposed in transit. Restrict access and move provisioning to HTTPS before using real or production credentials.

Do not use that transitional pattern as the final mobile security model. The target is for RANDY to receive telephony credentials server-to-server so SIP passwords do not need to reach the handset.

## Lock a device

```bash
curl -sS -X POST \
  http://127.0.0.1:8082/api/v1/admin/devices/dev_xxx/state \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Key: change-me' \
  -d '{"state":"locked"}'
```

Valid states are `active`, `locked`, `revoked`, and `retired`.

`revoked` and `retired` invalidate current access and refresh credentials.

## Credential rotation and recovery

Access credentials last 15 minutes by default and refresh credentials last 30 days.
Refresh rotation revokes the old refresh credential and inserts its new access
and refresh credentials within **one SQLite transaction**. A failure rolls back
the whole rotation.

Set `PROVISIONING_REFRESH_RETRY_KEY` to a strong, persistent random value in
`.env` to enable the 30-second retry window (configurable with
`REFRESH_RETRY_GRACE_SECONDS`). A repeated request using the previous refresh
token returns exactly the same replacement pair **only** while its successor
is still active. This handles a lost HTTP response. Without this key the
rotation remains atomic but retry replay is disabled. Keep the key stable;
changing it can prevent recovery of in-flight requests.

Invalid and expired refresh credentials are logged as
`token_refresh_rejected` without token material. An administrator revocation
always blocks refresh and retry. A previously lost or revoked credential
cannot be reconstructed from the database; those test devices need new
activation codes.

From the `provisioning-server` directory, run the unit tests with:

```bash
python3 -m unittest discover -s tests -v
```

This change does not perform device-record housekeeping or duplicate
installation cleanup. Those remain separate tasks.

## Storage

The reference implementation uses SQLite in WAL mode. Tokens are random opaque values and only SHA-256 hashes are stored in the database. Activation codes are also stored only as hashes.

This is suitable for the first integration/staging phase. The production service should move durable state to PostgreSQL and replace the development admin key with authenticated/authorized portal administration.

## Flutter test

Build/run the Flutter app with a default provisioning endpoint if desired:

```bash
flutter run \
  --dart-define=VOICEHOST_PROVISIONING_URL=https://provisioning.softphone.voicehost.io
```

Then open:

```text
Settings -> Provision device
```

and enter the generated activation code.

## Release 0.2: installation lifecycle and maintenance

Activation is atomic: the activation code, device row, both credentials and the
activation audit entry are committed together. A failure rolls everything back.
An active or locked installation using the same installation ID and platform
returns HTTP 409 with `installation_already_registered` **without consuming
the new activation code**. Retire or revoke the old device explicitly before
re-provisioning; logout retires the previous installation. Existing duplicate
records are left intact for review rather than automatically deleted.

Managed policy overrides manual fallback and managed-settings editing both
when issuing a new configuration and when returning an existing configuration.
The Flutter settings screen exposes only managed provisioning, diagnostics and
application information. Older client builds need upgrading; a server-side
policy cannot remove controls from an already installed old client.

Inventory example (the response deliberately excludes configuration and push secrets):

```bash
curl -sS -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  'http://127.0.0.1:8082/api/v1/admin/devices?limit=50&offset=0&state=active'
```

Housekeeping preview (safe default):

```bash
curl -sS -X POST -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"retention_days":90,"dry_run":true}' \
  http://127.0.0.1:8082/api/v1/admin/maintenance/housekeeping
```

After reviewing the counts, set `dry_run` to `false` to delete *only*
eligible expired or old revoked access/refresh credentials and expired or
consumed activation codes older than the configured retention threshold.
Device rows and audit events are retained. Automatic scheduling, data-model
migration, portal SSO and a web administration UI remain future work.

Run regression tests from this directory:

```bash
python3 -m unittest discover -s tests -v
```

Before deployment, back up the SQLite volume; validate the tests in a
staging environment and review existing duplicate installations. The local
development Compose binding is loopback-only. Always use an HTTPS reverse
proxy for remote mobile devices and never expose the staging admin key.

## Shared mobile-gateway NGINX and Certbot

The provisioning server **does not** publish public 80/443/8443 ports or
run a second NGINX. Both provisioning API containers join the existing
`mobile-gateway_default` network. The existing `mobile-gateway-nginx-1`
owns all public TLS listeners and uses the existing host certificate
directory `/etc/letsencrypt`. Keep its existing RANDY routing intact.

**Prerequisites:** DNS for `provisioning.softphone.voicehost.io` must
resolve to this host, and inbound 80/443 must reach the existing gateway
NGINX. Port 8443 should be firewalled to VoiceHost management/VPN
sources. Preserve the existing `.env` and provisioning-data volume.

1. Update both Compose projects and restart the provisioning backends:

   ```bash
   cd /opt/communicator && git pull origin feature/flutter-softphone
   cd provisioning-server && docker compose up -d --build --remove-orphans
   ```

   This removes the obsolete provisioning NGINX container that previously
   conflicted with the gateway's ports. Do not stop the mobile gateway.

2. Recreate only the gateway NGINX to add the shared ACME webroot and
   staged vhost mount. Run from the `mobile-gateway` directory:

   ```bash
   cd /opt/communicator/mobile-gateway
   mkdir -p certbot/www/.well-known/acme-challenge nginx/provisioning-enabled
   docker compose up -d --no-deps --force-recreate nginx
   echo voicehost-cert-test > certbot/www/.well-known/acme-challenge/test
   curl -fsS http://provisioning.softphone.voicehost.io/.well-known/acme-challenge/test
   ```

   The curl should return `voicehost-cert-test` **without** an HTTPS
   redirect. Do not request a certificate until this works. The HTTP
   server serves the ACME exception while redirecting ordinary paths.

3. Request the certificate using the **mobile-gateway** Certbot service,
   which stores certificates in the same host `/etc/letsencrypt` mounted
   read-only in gateway NGINX:

   ```bash
   docker compose run --rm --no-deps certbot certonly --webroot \
     --webroot-path /var/www/certbot --email simon@voicehost.co.uk \
     --agree-tos --no-eff-email \
     -d provisioning.softphone.voicehost.io
   ```

   If another host Certbot installation already manages renewal of the
   existing gateway certificates, configure renewal of this certificate
   in that existing scheduler rather than installing a competing one.

4. Edit `nginx/provisioning-tls.conf.example`: insert explicit
   `allow <VoiceHost management CIDR>;` rules before `deny all;`
   in the administration (8443) server. Its committed default is
   deny-all. Apply upstream firewall restrictions too. Then activate
   this configuration **after** the certificate is present:

   ```bash
   cp nginx/provisioning-tls.conf.example nginx/provisioning-enabled/provisioning.conf
   docker compose exec -T nginx nginx -t
   docker compose exec -T nginx nginx -s reload
   ```

5. Verify `https://provisioning.softphone.voicehost.io/health`
   returns `{"status":"ok"}`, while an attempt to visit
   `https://provisioning.softphone.voicehost.io/api/v1/admin/devices`
   returns 404. From an authorised management IP, open
   `https://provisioning.softphone.voicehost.io:8443/docs`.
   From elsewhere it must be blocked or return 403. The staging
   administration endpoints also require the `X-Admin-Key` header.

If using NGINX behind an upstream proxy, the source-IP allowlist must
use correctly validated client IPs or be enforced upstream. Do not
trust client-controlled `X-Forwarded-For` headers. The web admin UI,
individual administrator sessions, MFA and RBAC remain future work.
