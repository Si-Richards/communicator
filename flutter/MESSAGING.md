# Managed ejabberd messaging and conversation recovery

Account directory and extension addressing are implemented on this branch.
Install/configure the [ejabberd tenant module](../ejabberd-modules/mod_voicehost_tenants/README.md)
before rebuilding provisioning and installing this app update. Directory lists
only other active messaging identities in the account; search names/extensions,
tap a contact, or type its provisioned extension in New conversation. A SIP login
suffix such as `213t` stays internal when the provisioned extension is `213`.
Cross-account peers are rejected locally and by ejabberd. External invitations
and group conversations remain a future stage.

Work is isolated on `feature/ejabberd-messaging`, based on `feature/flutter-softphone`. This stage adds automatic managed login, encrypted local conversation storage and XEP-0313 archive recovery. The Messages tab is available in release/profile builds when managed messaging is enabled. Telephony and the mobile gateway are unchanged.

## Deployment order

1. Choose automatic account management or existing manual accounts, and check the archive policy below. [Automatic setup](../provisioning-server/EJABBERD-MANAGEMENT.md) creates/manages accounts on the provisioning server using the full SIP username, for example `10000*207@ejabberd.voicehost.io`. API credentials stay on the server.
2. Pull `feature/ejabberd-messaging` on the provisioning host and rebuild **both** provisioning containers from `provisioning-server/`:

   ```bash
   docker compose up -d --build provisioning provisioning-admin
   ```

   Retain the current `.env`, database volume, refresh retry key and admin portal configuration. Automatic mode also needs the documented ejabberd environment variables and `messaging-worker` service. The gateway does not need rebuilding. Keep the administration listener restricted as before.
3. In the provisioning portal, open **Devices → Edit** for the existing iPhone, or create a new activation. Enable messaging and select **Create and manage ejabberd account from the full SIP username** for automatic mode; then save. For existing manual accounts, enter:

   | Field | Example |
   | --- | --- |
   | Messaging account JID | `207@ejabberd.voicehost.io` |
   | Messaging password | The actual, dedicated password for account 207 |
   | Messaging WebSocket URL | `wss://ejabberd.voicehost.io/websocket` |

   Use the existing account password, separate from SIP. Leaving the password blank on an edit keeps it only for the same JID and WebSocket URL. Changing either requires a new password. Disabling messaging removes its credentials from the device configuration. Existing activations/configurations without these fields remain disabled. Explicit full JIDs allow the administrator to assign tenant-safe identities; do not map every tenant's extension 207 to the same global account.
4. Pull the branch on your Mac, then rebuild the iPhone app from `flutter/`:

   ```bash
   flutter pub get
   flutter analyze
   flutter test
   flutter run
   ```

   Use your existing signing setup. No new messaging entitlements or native XMPP library are required. Flutter already includes secure storage and application-support path plugins. A full rebuild is needed for the new Dart dependencies.
5. Let the phone check in, or refresh its provisioning configuration through Settings. Automatic accounts show **account being prepared** until the worker confirms readiness; another check-in then connects. Open **Messages** and expect automatic connection. Manual diagnostic login is only available in debug builds when managed messaging is disabled.

## ejabberd archive prerequisites

### If credentials do not appear on the phone

Check **Devices → Edit** for the phone's existing device ID, enable messaging,
select automatic account creation or enter its dedicated manual JID/password and save. Creating another activation does not
change an already enrolled phone. In the app, open **Settings → Provisioning**
and use **Refresh configuration**. The messaging line reports whether the cached
settings are absent, disabled, incomplete, blocked by feature policy or configured;
it never displays the password. A configured account with an authentication error
should be checked against ejabberd's existing account password.

The client acknowledges only the configuration it has downloaded and saved.
Failed downloads or secure-storage writes remain pending for the next check-in,
including after reopening the app. It also refreshes cached configurations saved
by older clients that discarded the messaging fields while keeping the same version.

Keep the working TLS/WebSocket route, `xmpp` subprotocol and SASL PLAIN-over-WSS configuration. Verify that `mod_disco` and `mod_mam` are enabled for the account's virtual host. The client discovers `urn:xmpp:mam:2` on its own bare JID.

Merge these MAM policy options into the existing `modules` section; do not replace the full ejabberd configuration:

```yaml
modules:
  mod_mam:
    default: always
    request_activates_archiving: false
```

Keep the existing archive database backend. A configured SQL backend is preferred for durable history; switching to `db_type: sql` also requires the matching SQL connection/schema setup and migration, so this deployment does not change it automatically. Back up the archive and set retention deliberately. Existing per-user MAM preferences can override `default`; verify those accounts actually archive incoming and outgoing text. Messages from before archiving was enabled cannot be reconstructed.

References: [ejabberd mod_mam options](https://docs.ejabberd.im/admin/configuration/modules/#mod-mam), [XEP-0313](https://xmpp.org/extensions/xep-0313.html), [XEP-0359](https://xmpp.org/extensions/xep-0359.html).

## On-device acceptance tests

1. Configure two identities using automatic SIP-name account creation or their existing dedicated account passwords. Both should connect without typing credentials on the phone. Confirm calls, CallKit and voicemail still work. For automatic mode, also run the shared-device lifecycle tests in the deployment guide.
2. Exchange text, then force-quit and reopen 207. Its conversations should remain. Delivery status survives local reopening; recovered outgoing messages from an empty cache show `sent`, not a claimed delivery/read receipt.
3. Background or disconnect 207. Send multiple messages from 208, then reopen 207. Missed archived messages should appear once, in chronological order. Repeat using Wi-Fi/mobile data switching.
4. With more than 100 archived messages, use **Load older messages** on the conversation list or chat. Paging applies to the account archive, so an older page can contain other conversations. The button stays disabled while offline or recovering.
5. Reinstall the test app and activate it for the same account. The most recent archive page should return, with older pages available. Reinstallation needs a valid new activation; it cannot recover messages deleted by server retention.
6. Lock the device in the portal. Messaging disconnects and visible history disappears. Unlock/check in and managed login restores the local cache and recovers missed messages. Logout, invalid provisioning credentials, revocation and retirement remove the current account's local cache when the app observes them. Server-side archives remain under ejabberd's retention policy.
7. Change the managed JID with a new account password. The previous account's conversations must not appear under the new identity. Rotate only the password and confirm the same account's history remains.

## Storage and recovery behavior

- Provisioned XMPP credentials are saved in the existing secure provisioning blob (iOS Keychain). They are never placed in preferences, diagnostic events or the conversation file. The portal returns a password-configured flag, not the password. Validation responses omit submitted input and API credential responses use `Cache-Control: no-store`.
- Conversations use AES-256-GCM with a fresh nonce and authenticated account/endpoint binding. The encryption key is in secure storage; encrypted files are in application support, named using an account/endpoint digest. Writes are serialized and atomically replace the old file. The persistent cache keeps at most 2,000 recent messages and approximately 4 MiB of message data. Loaded older pages remain available in the current session.
- On first login or an empty cache, the client requests the most recent 100 archive records using RSM `before`. On reconnect it pages forward from the last durably saved archive cursor, up to 50 pages per recovery run. Larger backlogs show an unfinished-recovery notice; **Retry history** continues from the saved cursor. Older history pages backwards using RSM.
- A page is committed only after its matching IQ `fin`; partial pages from an interrupted connection are discarded. The cursor advances only with a successful durable cache write. Storage failures display an error and leave the cursor recoverable. An unreadable/tampered cache is not silently overwritten; archive text can still be displayed for that session, but persistence remains unavailable until the local cache is repaired or the app is reinstalled.
- Live and archive text reconcile using trusted archive IDs or matching peer, direction, client/origin ID and body. Only correlated archive results from the account archive are accepted. Archived messages never generate delivery receipts. Outgoing delivery status is preserved when the local copy already has a receipt.
- An expired archive cursor falls back to the latest available page and retains local text, with a notice. Older gaps can remain if server retention removed them. A server without MAM still supports local/live messaging and displays an archive-unavailable notice.
- Background suspension closes the XMPP connection. Foreground resume authenticates again and recovers history; CallKit's temporary `inactive` state does not pause messaging. Authentication failures stop retries; use **Reconnect** after correcting credentials/connectivity.

## Scope and verification

Supported: managed login, one-to-one same-domain text, local conversations, archive recovery, older pages, XEP-0184 delivery receipts, XEP-0359 outgoing origin IDs, lifecycle reconnect and provisioning access enforcement. `sent` means handed to the WebSocket, not proof of server acceptance. Text is encrypted locally and transported over TLS; this is not end-to-end encryption.

Not yet included: APNs/FCM messaging notifications, XEP-0198 stream resumption, outbox/retry guarantees, live message carbons between multiple clients, attachments, groups, typing/read markers or roster/name lookup. Background messages appear on return to the app; enabling `mod_push` alone does not provide notifications.

The protocol tests use a real loopback WebSocket fixture for login, routing, receipts, MAM discovery/paging, duplicate recovery, interrupted pages, expired cursors, failed storage, account changes and lock/logout. Storage tests verify encrypted reopening, account/endpoint isolation and tamper rejection. Provisioning tests verify credential retention/rotation, account-change validation, disablement, portal redaction and validation secrecy. These checks supplement the on-device tests above; this environment cannot build/sign an iOS binary or verify your private account's live archive.
