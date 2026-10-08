# Standard APNs message notifications

This adds ordinary iOS message alerts to managed, tenant-isolated messaging.
**No fresh device activation is required.** Existing enrolled iPhones register
when the updated app opens and messaging is ready. Upgrade ejabberd first, then
provisioning, then the app. Leave the current SIP, RANDY calling and VoIP PushKit
configuration in place.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| iPhone app | Registers its standard APNs token through authenticated device provisioning; enables a device-specific XEP-0357 node; validates notification taps after refreshing provisioning |
| ejabberd `mod_push` | Generates events for disconnected registered sessions when chat messages are archived/offline; a different online phone does not suppress the offline phone |
| `mod_voicehost_tenants` | Enforces the existing tenant policy and durably queues metadata for VoiceHost push nodes |
| Provisioning API | Associates a random push node with the authenticated device and its current canonical messaging JID |
| RANDY `messaging-notifications` container | Pulls events through the private ejabberd API, commits SQLite jobs before acknowledging them, rechecks eligibility and sends standard APNs alerts |
| `messaging-worker` | Continues account creation, bans/unbans, directory publication and archive migration |

There is no new public webhook, XMPP component or notification listener.
The existing restricted HTTPS `/api/v2/` proxy remains in use. RANDY needs
outbound HTTPS access to Apple's sandbox and production APNs endpoints on port
443. Keep ejabberd API access limited to the provisioning infrastructure and its
dedicated authenticated account. The existing phone provisioning HTTPS endpoint
carries token registration.

The first alert is deliberately generic: **“New VoiceHost message”**. Message
text, SIP passwords and messaging passwords are never passed through the event
queue or APNs payload. The payload contains account/conversation identifiers;
these remain sensitive metadata. APNs keys and device tokens stay on the server.
Keep both the SQLite database and Mnesia data in your protected backups.

No chat badge count, Android FCM, attachments, group notifications or guest
invitations are included in this stage. Normal UserNotifications are used for
chat; PushKit remains dedicated to calls. The gateway's voicemail notifications
remain separate.

## 1. Update ejabberd: 149.19.177.17

Back up the working configuration and Mnesia database. Update the existing
checkout; do not clone over it:

```bash
git -C /opt/voicehost-messaging pull --ff-only origin feature/ejabberd-messaging
```

Upgrade the installed module with the running installation's control command:

```bash
bash /opt/voicehost-messaging/ejabberd-modules/mod_voicehost_tenants/install.sh /opt/ejabberd-26.09/bin/ejabberdctl --upgrade
```

Merge into the existing `/opt/ejabberd/conf/ejabberd.yml` sections. Retain the
existing lifecycle, directory and archive permissions; add the last two commands.
Do not create a second `modules` or `api_permissions` section:

```yaml
modules:
  mod_voicehost_tenants: {}
  mod_push:
    notify_on: messages
    include_body: "New VoiceHost message"
    include_sender: false

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
      - voicehost_set_identity
      - voicehost_migrate_history
      - voicehost_push_events
      - voicehost_ack_push
```

The static `include_body` string is required with `notify_on: messages`: setting
both `include_body` and `include_sender` to `false` makes ejabberd suppress the
notification before our hook. The static string reveals no message contents.

Keep `mod_mam`, `mod_offline`, `mod_private` and the current roster/tenant
configuration. Keep the archive backend unchanged. Keep the API listener on
loopback and its versioned proxy route unchanged.

Restart during a maintenance window: the new Mnesia queue and hook are installed
at module start, so a configuration reload alone is insufficient. This briefly
interrupts connected clients; they reconnect automatically.

```bash
/opt/ejabberd-26.09/bin/ejabberdctl restart
```

Once the node has restarted, check it and the new commands:

```bash
/opt/ejabberd-26.09/bin/ejabberdctl status
```

```bash
/opt/ejabberd-26.09/bin/ejabberdctl --version 2 help voicehost_push_events
```

```bash
/opt/ejabberd-26.09/bin/ejabberdctl --version 2 help voicehost_ack_push
```

## 2. Configure and rebuild RANDY: 149.19.177.56

Update the existing checkout and retain its `.env`, persistent refresh retry key
and database volume:

```bash
git -C /opt/communicator pull --ff-only origin feature/ejabberd-messaging
```

```bash
cd /opt/communicator/provisioning-server
```

Put an Apple APNs authentication `.p8` key into
`/opt/communicator/provisioning-server/secrets/messaging-apns.p8` using your secure
key transfer process. This key must be authorized to send **standard** notifications
for the Runner app's bundle ID. You may reuse an existing provider key only if it
has that authorization. Do not paste its contents into `.env`, Git or logs.

```bash
chmod 600 /opt/communicator/provisioning-server/secrets/messaging-apns.p8
```

Set these values in the existing `.env`:

```dotenv
MESSAGING_PUSH_ENABLED=true
MESSAGING_APNS_TEAM_ID=YOUR_APPLE_TEAM_ID
MESSAGING_APNS_KEY_ID=YOUR_APNS_KEY_ID
MESSAGING_APNS_BUNDLE_ID=YOUR_RUNNER_BUNDLE_ID
MESSAGING_APNS_KEY_PATH=/run/secrets/messaging-apns.p8
```

Use the ordinary bundle ID, without a `.voip` suffix. Retain the existing working
`EJABBERD_MANAGEMENT_ENABLED=true`, API credentials, host and
`EJABBERD_API_URL=https://ejabberd.voicehost.io/api/v2`. The key is mounted read-only
only in the notification worker; it is excluded from the Docker build context.

Build and recreate all four services so both the public API and worker receive
the updated settings:

```bash
docker compose -f docker-compose.yml up -d --build provisioning provisioning-admin messaging-worker messaging-notifications
```

The notification service is optional and has a `messaging-push` Compose profile.
Naming the service explicitly, as above, activates it. A plain `docker compose up`
without that profile does not start it or require a key file.

If your gateway Nginx holds old provisioning container addresses after recreation,
reload it using the existing deployment procedure. No proxy route changes are
needed for this feature.

Inspect startup and logs:

```bash
docker compose -f docker-compose.yml ps messaging-notifications
```

```bash
docker compose -f docker-compose.yml logs --tail=80 messaging-notifications
```

`Could not load messaging APNs credentials` means the mount, key or provider
configuration must be corrected. Permission failures naming `voicehost_push_events`
or `voicehost_ack_push` mean the new module/API permissions are missing. Network
errors identify the failure class without printing response bodies or tokens.

## 3. Update the iPhone app on the Mac

Pull the branch in your existing checkout, enter `flutter/`, and rerun the native
configuration script. This copies the updated AppDelegate template into Runner:

```bash
./tool/configure_ios_pushkit.sh
```

Then run each command separately:

```bash
flutter pub get
```

```bash
flutter analyze
```

```bash
flutter test
```

```bash
flutter run
```

Retain Runner's **Push Notifications** capability and your working Apple signing
configuration. Approve notifications on the phone. These use the existing standard
APNs token, separate from the VoIP token. The app reads the signed provisioning
profile's `aps-environment`: development uses sandbox; App Store/TestFlight uses
production. A development-signed Release build still uses sandbox.

Open the enrolled app and let provisioning refresh until messaging is ready.
Registration retries approximately once a minute while the app runs; the XMPP
subscription is enabled when its authenticated session is online and again after
reconnect. The app's messaging diagnostics show **Notifications registered** once
ejabberd accepts that subscription. This proves registration, not Apple delivery.

Disabling notification permission removes the server registration on the next
app registration check. Lock, revoke, retire/logout, messaging disablement and
account changes invalidate the old node. Unlocking or re-enrolling obtains a fresh
node when the app next opens, so old queued events cannot be reactivated.

## 4. Acceptance checks

Use two extensions in account `10000` and a separate account `20000`. Include two
iPhones sharing one canonical extension if possible.

1. Start with ordinary foreground chat; confirm existing chat and directory work.
   Foreground message alerts are suppressed to avoid duplicating the live chat.
2. Put the recipient app in the background and send a new message from another
   extension in the same account. Expect a generic standard iOS alert. Tap it;
   the app refreshes provisioning, checks the owning JID and opens the appropriate
   conversation. Message contents come from live XMPP/MAM, not the push payload.
3. Repeat with the recipient app terminated and test a cold-start tap on a real
   signed device. Simulator results do not replace this test.
4. Keep one phone for an extension online and background its second phone. Send
   to that extension; the second phone should receive its own alert.
5. Attempt cross-account traffic from `20000`. Expect ejabberd rejection and no
   notification. An old notification from a different enrolled account must not
   open that account's conversation after reprovisioning.
6. Lock the recipient device in the portal, then send. Expect no new alerts for
   that installation, even if another phone keeps its shared JID enabled. Unlock,
   open the app to register its new node, then test a fresh message. Repeat for
   revoke/logout and messaging feature disablement.
7. Deny notifications, reopen the app and check that its registration disappears.
   Restore permission and reopen to register again. Test a replacement installation
   or token rotation; the old node must no longer receive delivery jobs.
8. Stop the notification worker, send a message, then restart it within 15 minutes.
   Expect queue recovery. Restarting must not send a completed SQLite job again.
   Longer outages expire alerts while archived messages still recover on login.
9. Verify incoming calls, PushKit/CallKit and voicemail notifications still work.

Inspect counts without dumping device tokens, opaque nodes or credentials:

```bash
docker compose -f docker-compose.yml exec -T messaging-notifications python -c 'import sqlite3; from app.config import settings; c=sqlite3.connect(settings.database_path); print("Registered devices:",c.execute("SELECT COUNT(*) FROM messaging_push_devices").fetchone()[0]); print("Jobs:",c.execute("SELECT status,COUNT(*) FROM messaging_push_jobs GROUP BY status").fetchall()); c.close()'
```

For a delivery problem, inspect controlled errors:

```bash
docker compose -f docker-compose.yml exec -T messaging-notifications python -c 'import sqlite3; from app.config import settings; c=sqlite3.connect(settings.database_path); print(*c.execute("SELECT status,attempts,error FROM messaging_push_jobs WHERE error IS NOT NULL ORDER BY created DESC LIMIT 10").fetchall(),sep="\n"); c.close()'
```

Apple HTTP 410 or `BadDeviceToken` removes that registration. The app can register
again when it next opens. `DeviceTokenNotForTopic`, `BadTopic` or provider-token
errors require checking the key, team, key ID, bundle ID and signed environment.
Do not switch to the other APNs environment as a fallback for a rejected token.

## Delivery limits and rollback

The ejabberd queue stores metadata only, is capped at 50,000 events, and expires
alerts after 15 minutes. SQLite retains job metadata for seven days. Transient
network/Apple failures retry with a bounded backoff until expiry. Jobs are committed
before remote acknowledgement; repeated pulls deduplicate by event ID.

APNs is a best-effort hint. Alerts may be delayed or collapsed per conversation.
A process crash or lost response after Apple accepts a request may cause a retry;
stable APNs IDs/collapse IDs reduce duplication but do not provide exactly-once
Apple delivery. Message history remains authoritative. Locking cannot recall an
alert Apple already accepted before the lock committed. Alerts carry generic text,
and tapping always checks the current provisioning state and account before
opening chat.

To stop new delivery, stop the worker, set `MESSAGING_PUSH_ENABLED=false` and
recreate provisioning/public-admin with the updated environment. Leave the new
SQLite tables and Mnesia table intact; the existing messaging lifecycle continues.
No account, password or archive rollback is required. Re-enable with the four-service
command once the provider issue is corrected.

## Validation and references

Automated provisioning tests cover device-authenticated registration, account and
host boundaries, multiple phones, token transfer/rotation, lock/unlock invalidation,
queue persistence/deduplication/ACK ordering, concurrent workers, retries/expiry,
provider JWT signing and standard APNs headers. Erlang tests exercise the real
Mnesia queue and existing tenant enforcement against ejabberd 26.09 headers.
Standalone Dart model checks validate notification/subscription boundaries. The
Flutter wire tests also cover push enable/disable, rejection and reconnect; run
them and `flutter analyze` on the Mac before signing the release. Live Apple
delivery and the iOS native build require your credentials/signing environment.

- [XEP-0357 push notifications](https://xmpp.org/extensions/xep-0357.html)
- [ejabberd mod_push](https://docs.ejabberd.im/admin/configuration/modules/#mod-push)
- [Apple APNs request format](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
