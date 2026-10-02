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
  http://127.0.0.1:8081/api/v1/admin/devices/dev_xxx/state \
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
  --dart-define=VOICEHOST_PROVISIONING_URL=https://provision-dev.voicehost.io
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
  'http://127.0.0.1:8081/api/v1/admin/devices?limit=50&offset=0&state=active'
```

Housekeeping preview (safe default):

```bash
curl -sS -X POST -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"retention_days":90,"dry_run":true}' \
  http://127.0.0.1:8081/api/v1/admin/maintenance/housekeeping
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

## Separate HTTPS ingress (release 0.3 foundation)

Use `nginx/provisioning.softphone.voicehost.io.conf` as the reference
reverse-proxy configuration on the same host. Obtain a certificate covering
`provisioning.softphone.voicehost.io`; replace example certificate paths if
your certificate manager uses different paths.

- Device API: `https://provisioning.softphone.voicehost.io` (443, public).
- Administration API/Swagger: `https://provisioning.softphone.voicehost.io:8443/docs`
  (8443, limited to VoiceHost management networks/VPN).
- Public Uvicorn: `127.0.0.1:8081` (no administration routes registered).
- Admin Uvicorn: `127.0.0.1:8082` (no device routes registered).
- Admin API still requires `X-Admin-Key` in staging; a portal-authenticated
  web UI, individual administrator sessions, MFA and RBAC have **not**
  been implemented. Do not distribute the shared key to browser clients.

Before enabling NGINX, create
`/etc/nginx/snippets/softphone-provisioning-admin-allowlist.conf` with
explicit `allow <management IP or VPN CIDR>;` entries followed by `deny all;`.
Restrict port 8443 at the host firewall as an additional layer, and ensure
8081/8082 are not externally exposed. If NGINX runs on a *different* host,
replace loopback backends with private network addresses and firewall them
accordingly. NGINX must already be installed, its included configuration
must not conflict with existing listeners, and TLS certificates and DNS must
be in place before changing the mobile default URL.

Check route isolation and health after deploying:

```bash
docker compose up -d --build
curl -sS http://127.0.0.1:8081/health
curl -sS http://127.0.0.1:8082/health
curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8081/api/v1/admin/devices
curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8082/api/v1/device/configuration
```

Both route probes should return 404. API documentation on each port
advertises only its respective routes. Once NGINX is enabled also check
that port 443 returns 404 for admin routes and that access to 8443 is denied
from outside authorised networks. Existing installed Flutter builds may
retain a previously saved provisioning URL; reconfigure or migrate those
installations deliberately after the new HTTPS endpoint is available.
