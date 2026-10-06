# ejabberd messaging: foreground test milestone

This change adds an independent XMPP service and a debug-only messaging test flow to the existing Flutter app. It never connects during startup or blocks provisioning, Janus, SIP registration, or calls.

## Run on your iPhone

Switch to `feature/ejabberd-messaging`, then from `flutter/`:

```bash
flutter pub get
flutter analyze
flutter test
flutter run
```

A full stop/rebuild is needed after adding the XML dependency. No additional iOS capabilities or CocoaPods native messaging library are needed.

1. Confirm the existing softphone is provisioned and calls still work.
2. Open **Phone → Settings → Messaging diagnostics** (debug builds only). The bug icon on the Messages tab opens the same page.
3. Enter an existing ejabberd test username such as `207` and its actual password. Passwords are not included in the code or prefilled. Tap **Connect**.
4. Expect `connecting → authenticating → binding → online`. The page shows the bound JID with a unique platform/device-session resource.
5. Connect a second app/client as `208@ejabberd.voicehost.io` and send a test message to `208`. Both clients must be online for this milestone. Check `ejabberdctl connected_users` on the server.
6. Open **Messages** to see the conversation, reply, or use the compose button to start another local conversation. Messages show `sent`, `delivered` (when the recipient supports receipts), or `failed` (server rejection). `sent` means handed to the WebSocket; it is not proof of server acceptance. No read receipts are claimed.
7. Background and reopen the app, then check it reconnects. Switch Wi-Fi/mobile data and verify recovery. Explicit disconnect cancels retries.
8. Lock/revoke the device through provisioning: messaging must disconnect, clear the in-memory messages, and reject further connections until access is restored. It does not automatically reconnect after unlock.

The earlier sample test passwords are examples only. Use the passwords you actually assigned to the test accounts; do not reuse SIP credentials.

## Protocol and security

- Endpoint: `wss://ejabberd.voicehost.io/websocket`, port 443; WebSocket subprotocol `xmpp`.
- RFC 7395 opening/restarting, SASL PLAIN **over normal certificate-validated TLS only**, RFC 6120 resource binding, optional legacy session establishment, presence, XMPP ping responses and XEP-0184 delivery receipts.
- `auth_password_format: scram` is ejabberd's password storage format and can remain enabled with SASL PLAIN. The server must advertise PLAIN over WSS; the diagnostics page explicitly reports when it does not.
- The application never calls the ejabberd administrative API.
- Credentials remain in memory for reconnect, and are cleared on disconnect, login failure, lock/revocation, and service disposal. The password entry is cleared when connecting and disposed when leaving the page.
- Fixed diagnostic summaries contain no raw XML, authentication payloads, usernames/JIDs or message bodies. The bound JID is intentionally visible on the diagnostics page.
- Up to five transport reconnect attempts use 1/2/4/8/16-second backoff. Authentication/protocol failures stop retries; connect timeout is 15 seconds, then the login handshake has a 20-second deadline.
- iOS background suspension closes this test session; returning to the foreground authenticates again. CallKit's temporary `inactive` state does not suspend messaging. This is not XEP-0198 stream resumption.
- Each session is limited to 500 in-memory messages and 60 diagnostic events. Switching test accounts clears the previous account's messages.

Whixp 3.3.1 was inspected before implementation. Its pub.dev archive imports `lib/src/native/transport_ffi.dart` but does not include that file, and its iOS podspec references a native transport archive/XCFramework absent from the package. This milestone therefore uses the existing `web_socket_channel` dependency and the `xml` parser; no Whixp native dependency is introduced. The focused service can be replaced behind the same UI later.

## Scope of this milestone

Implemented: test login, conversation list, foreground send/receive, XML escaping, delivery receipts, sanitized events, reconnection, lifecycle cleanup and provisioning access enforcement.

Not implemented yet: MAM archive retrieval, persistent conversation storage, message retry/outbox and archive reconciliation, XEP-0198, typing/read markers, roster/name lookup, attachments, group chat, managed messaging provisioning, or APNs/FCM messaging push. Offline/archive messages are not retrieved by this milestone. Messages disappear when the process is restarted. Enabling `mod_push` alone does not add push delivery.

The manual test entry points and conversation UI are disabled in release/profile builds until managed provisioning is implemented. The existing Calls/CallKit/PushKit implementation is unchanged. Ordinary message notifications will use standard APNs, not the VoIP PushKit channel.

## Server troubleshooting

Follow `journalctl -u ejabberd -f` and the NGINX ejabberd logs while connecting. The upgraded WebSocket access-log entry may not appear until the connection closes.

A valid external handshake probe is:

```bash
curl --http1.1 -i --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: xmpp' https://ejabberd.voicehost.io/websocket
```

Expect `101 Switching Protocols` with `Sec-WebSocket-Protocol: xmpp`. A timeout **after** 101 is expected because the upgraded connection remains open. This probe confirms the TLS/proxy/upgrade path, not XMPP authentication. The sample key decodes to the required 16-byte nonce.

## Automated verification

`test/xmpp_service_test.dart` uses a loopback WebSocket server with real XML framing and two clients. It exercises login/binding, two-way routing and receipts, XML escaping, failed authentication, required legacy sessions, wrong bound identity, delayed-message deduplication, ping, lifecycle reconnection, account isolation, lock enforcement and malformed-response redaction. It does not replace an on-device test against live ejabberd.
