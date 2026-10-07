# Automatic ejabberd account lifecycle

Automatic messaging uses the **full SIP username**, lowercased, as the XMPP
username: `10000*207` becomes `10000*207@ejabberd.voicehost.io`. A short extension
is not substituted when the SIP username is missing. Multiple phones with the
same SIP identity share one account and generated messaging password. The SIP
password is never copied to ejabberd.

| Provisioning event | Account behavior |
| --- | --- |
| Issue an activation code | No account created yet |
| Activate a phone with automatic messaging | Reserve one password; worker creates the account |
| Add another phone with the same SIP username | Reuse the account and password |
| Lock, revoke, retire, log out or disable messaging | Disable the account when no active linked phones remain |
| Unlock a linked phone or activate a replacement | Restore the account with the same password |
| Change the SIP username | Attach the phone to the new account; reconcile the old account's remaining phones |

Disabling uses `ban_account`; enabling uses `unban_account`. It never calls
`unregister`, changes the account password, or deletes message history. The
worker only removes bans bearing its own account-specific reason. An account
already present outside provisioning ownership is reported as a conflict and
is not overwritten. Existing manual account configurations remain manual.

## ejabberd prerequisites

Use **ejabberd 25.08 or newer** and API **v2**. Version 2 selects the ban behavior
that preserves the password and records a ban in private storage. Require
`mod_admin_extra`, `mod_private` and `mod_http_api`; keep the existing archive
and WebSocket modules/configuration.

Merge this example into the existing ejabberd configuration, replacing
`PRIVATE_INTERFACE_IP`. Do not duplicate top-level YAML sections or replace
the working WebSocket listener. Use a listener certificate valid for the
hostname used by `EJABBERD_API_URL`. The provisioning client's TLS verification
is enabled; self-signed certificates need a trusted deployment CA setup.

```yaml
listen:
  - port: 5444
    ip: "PRIVATE_INTERFACE_IP"
    module: ejabberd_http
    tls: true
    request_handlers:
      /api/v2: mod_http_api

acl:
  voicehost_provisioner:
    user: provisioning-api@ejabberd.voicehost.io

api_permissions:
  "VoiceHost provisioning lifecycle":
    from:
      - mod_http_api
    who:
      acl: voicehost_provisioner
    what:
      - register
      - check_account
      - check_password
      - get_ban_details
      - ban_account
      - unban_account

modules:
  mod_admin_extra: {}
  mod_private: {}
  mod_http_api: {}
```

Create the dedicated `provisioning-api` account once using the existing secure
ejabberd administration process. Its password is an infrastructure credential;
it is never delivered to phones. Restrict the listener and firewall to the
provisioning host. If TLS terminates in NGINX, expose this API through a separate
restricted listener and preserve `/api/v2/`; keep it off the public WebSocket
listener. Keep existing broader API permission rules from inadvertently granting
unauthenticated access to these commands.

References: [API authentication and listeners](https://docs.ejabberd.im/developer/ejabberd-api/simple-configuration/),
[ban/unban/register commands](https://docs.ejabberd.im/developer/ejabberd-api/admin-api/).

## Provisioning deployment

Back up the existing provisioning database volume. Pull
`feature/ejabberd-messaging` and add these settings to the existing `.env`, using
the private HTTPS API hostname and dedicated API password:

```dotenv
EJABBERD_MANAGEMENT_ENABLED=true
EJABBERD_HOST=ejabberd.voicehost.io
EJABBERD_WEBSOCKET=wss://ejabberd.voicehost.io/websocket
EJABBERD_API_URL=https://ejabberd.voicehost.io:5444/api/v2
EJABBERD_API_USERNAME=provisioning-api@ejabberd.voicehost.io
EJABBERD_API_PASSWORD=<dedicated API password>
```

Keep all existing provisioning/portal/refresh settings and the database volume.
Rebuild the app on the messaging branch **before enabling automatic accounts**;
older builds do not understand account readiness or SIP usernames containing `*`.

From `provisioning-server/`:

```bash
docker compose up -d --build provisioning provisioning-admin messaging-worker
docker compose run --rm --no-deps provisioning python -m unittest discover -s tests -v
docker compose logs --tail=50 messaging-worker
```

The gateway does not need rebuilding. The worker has no published port. When
`EJABBERD_MANAGEMENT_ENABLED=false`, it waits without calling ejabberd and the
server rejects attempts to enable new automatic configurations. Existing automatic
accounts are not disabled merely by switching off the integration.

In **Devices → Edit**, select **Enable messaging** and **Create and manage ejabberd
account from the full SIP username**. Fill the SIP username if missing, save,
then reopen the editor to see the account status and active-phone count.
The JID, messaging password and WebSocket fields are disabled in automatic mode.
New activations have the same option. A generated activation alone does not
modify an enrolled phone.

The worker checks committed device state every five seconds. Failures retry with
backoff from five seconds up to five minutes; changing the desired state bypasses
the previous target's backoff. On the phone, **Settings → Provisioning → Refresh
Configuration** applies readiness immediately after the worker succeeds; otherwise
normal check-in polling applies it. Initial account creation shows **account being
prepared** and starts XMPP login only after readiness is provisioned.

## Shared-account limits and verification

The database registry stores account ownership and its stable generated secret;
the portal returns status/count/error only. The device receives its account secret
inside the existing authenticated, non-cacheable configuration response and saves
it in secure storage. Database backups must retain the registry together with
device records. The worker's errors never include raw API requests/responses.

With a shared account, locking **one** phone cannot invalidate that shared password
while other phones remain active. That phone's app disconnects when it observes its
provisioning lock. Last-device disablement bans the ejabberd account and terminates
its sessions. Immediate independent server revocation of a single phone would need
per-device authentication or a separate session enforcement mechanism.

Device edits and each account's API reconciliation are serialized using SQLite
write transactions, including across separate public/admin/worker processes.
Network operations have a three-second per-operation timeout. Provisioning writes
can briefly wait while an account is reconciled; this is not a high-throughput
distributed account-management service. API success followed by process failure
is recovered by inspecting the remote account and verifying the persisted secret
or provisioning ban marker. Password mismatches and unrelated administrator bans
remain errors for explicit administrator resolution.

Before rolling out, test one new identity, a second phone on that identity, each
lock/unlock combination, retirement/replacement, SIP username changes, API outage
and restoration, and message history after disable/re-enable. Provisioning unit
tests use an HTTP transport fixture; live TLS, permissions, ejabberd version and
archive preservation still require acceptance on your infrastructure.
