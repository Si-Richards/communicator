# VoiceHost Provisioning Server

Standalone reference/staging implementation of the VoiceHost endpoint provisioning API.

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
- `GET /api/v1/admin/devices/{device_id}`
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

The container listens on port 8080 and the supplied compose file binds it to `127.0.0.1:8081`.

Health:

```bash
curl http://127.0.0.1:8081/health
```

Swagger:

```text
http://127.0.0.1:8081/docs
```

## Create an activation code

A RANDY-managed test endpoint that relies on existing/manual SIP credentials:

```bash
curl -sS -X POST http://127.0.0.1:8081/api/v1/admin/activations \
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
