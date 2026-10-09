# Private multi-user rooms

Rooms are account-only, members-only and persistent. `10000*213`, `213T` and
`213D` share canonical user `10000*213@ejabberd.voicehost.io` and room membership.
Current members can read the full retained room history, including messages sent
before they joined. Attachments keep their existing 30-day retention and 10 MiB
limit. External users and cross-account invitations are not enabled.

## Roles and enforcement

The creator is an owner. Owners/admins rename rooms and add enabled account users;
admins remove ordinary members. Owners assign member/admin/owner roles, remove
members and close rooms. Anyone can leave, but the last owner must appoint another
owner first. Disabling every owner leaves room management unavailable until an
owner is restored by provisioning. Limits: 100 members per room and 256 room
records (including closed rooms) per account.

The `voicehost_room` Mnesia registry owns membership, revision and readiness.
The device API derives the actor from its authenticated, active, ready managed
identity. ejabberd independently checks actor, account, role and revision, blocks
raw XMPP owner/admin/invite operations, rejects nickname spoofing, and checks
membership for message routing and MAM history. Room changes fail closed while
native affiliations/subscriptions synchronize. The messaging worker repairs
interrupted changes every minute; retry creation with the same operation ID.

Users join `vh-<32 hex digits>@rooms.ejabberd.voicehost.io` under their numeric
extension. Friendly room/sender labels come from provisioned identity data.
Membership refreshes every 30 seconds while messaging is online in the foreground;
Refresh in Rooms checks immediately. MUC subscriptions deliver across a user's
resources and support the existing per-device APNs path when a session is offline.
Room APNs eligibility is checked again before delivery and on notification opening.
Removal, leave, closure or identity disable denies subsequent messages, archive
queries, file downloads and alerts. Copies already seen, downloaded or delivered
cannot be remotely erased. The app hides/purges room messages when refreshed
membership no longer includes the room.

Room messages show dates, sender names/extensions, typing, unread counts and
"Read by N" for distinct readers. "In room" means the server echoed the message,
not that every member received it. Read/typing sharing preferences apply to rooms.
A newly added member can page through all retained history with Load older messages.
Images and files use the authenticated provisioning attachment service. There is
no new public file endpoint or public ejabberd administrative API.

## 1. Update ejabberd on 149.19.177.17

Back up existing ejabberd configuration and Mnesia data, and retain all current
identity, archive and push tables. Use the installed 26.09 control executable.

```bash
cd /opt/voicehost-messaging
git pull --ff-only origin feature/ejabberd-messaging
bash ejabberd-modules/mod_voicehost_tenants/install.sh /opt/ejabberd-26.09/bin/ejabberdctl --upgrade
```

Merge the [room configuration snippet](../ejabberd-modules/mod_voicehost_tenants/rooms.yml.example)
into `/opt/ejabberd/conf/ejabberd.yml`. Keep the current module options and existing
API permissions. In `modules.mod_muc`, add both service hosts, preserving any
additional existing MUC hosts:

```yaml
    hosts:
      - "conference.@HOST@"
      - "rooms.@HOST@"
```

Keep `mod_muc_admin`, `mod_mam`, `mod_push`, `mod_roster` and
`mod_voicehost_tenants` enabled. Add these four commands to the dedicated
`voicehost_provisioner` HTTP API permission's `what` list:

```yaml
      - voicehost_room_list
      - voicehost_room_create
      - voicehost_room_manage
      - voicehost_room_repair
```

Do not grant the provisioner arbitrary MUC admin commands or wildcard permissions.
Restart to load both production modules and initialize the persistent room table:

```bash
/opt/ejabberd-26.09/bin/ejabberdctl restart
/opt/ejabberd-26.09/bin/ejabberdctl status
/opt/ejabberd-26.09/bin/ejabberdctl --version 2 help voicehost_room_create
/opt/ejabberd-26.09/bin/ejabberdctl --version 2 help voicehost_room_list
```

Allow restart to complete before checking status. Keep existing TLS/WSS and private
HTTPS `/api/v2` routes. No Nginx change, public 5281 listener or new DNS/TLS
certificate is needed: the room service is addressed inside the existing XMPP
WebSocket connection.

## 2. Update provisioning on 149.19.177.56

Preserve the SQLite and private attachments volumes, existing API credentials and
APNs key mount. No fresh enrollment or password rotation is needed.

```bash
cd /opt/communicator/provisioning-server
git pull --ff-only origin feature/ejabberd-messaging
docker compose -f docker-compose.yml up -d --build provisioning provisioning-admin messaging-worker messaging-notifications
docker compose -f docker-compose.yml logs --tail=80 messaging-worker messaging-notifications
```

The public device API adds authenticated GET/POST `/api/v1/device/messaging/rooms`
and POST `/api/v1/device/messaging/rooms/{room_id}`. Membership never comes from
a supplied actor field. The existing proxy must already forward the device API
without rewriting it. HTTP 409 means refresh a stale revision; 503 can mean an
interrupted native synchronization awaiting worker repair. 403 denies a role/owner
change. Unknown and inaccessible rooms use 404.

## 3. Update Flutter on the Mac

```bash
git pull --ff-only origin feature/ejabberd-messaging
cd flutter
flutter pub get
flutter analyze
flutter test
dart --enable-asserts tool/check_messaging_rooms.dart
flutter run
```

Use the normal signed iOS build with existing Push Notifications capability.
Room alerts use standard messaging APNs, separate from incoming-call PushKit.
The native PushKit template is unchanged by this room update.

## Acceptance checks

1. Update two users in account 10000. In Messages → Rooms → Create, enter a name
   and select account users. Check room and sender names, numeric extensions and
   dates/times. Send text, a camera photo and a file; open them on the other phone.
2. Check typing and "Read by N" while the other user views the message. A second
   device on the same canonical user must not increase the reader count twice.
   Hide the app and confirm unread counts update when it returns.
3. Add a third enabled user after sending several messages. That user sees earlier
   history and can download an earlier retained attachment. Load older pages;
   reconnect and check message/attachment metadata remains intact without duplicates.
4. Log in on another SIP endpoint/device for the same user. It sees the same
   rooms, messages and membership. Background an iOS recipient with APNs enabled;
   send a room message, check one per-device alert, and tap it to open the room.
5. Promote an admin. Verify rename/add/remove-member work but appointing an owner,
   removing an owner or closing the room does not. Promote another owner, then
   leave as the original owner. Try stale simultaneous changes: refresh after 409.
6. Remove a member or disable its last active provisioned endpoint. Its socket
   cannot send or fetch room history; it cannot download files or receive queued
   room alerts. Rooms → Refresh removes the room after membership removal.
   Re-enable an identity to restore its existing membership; removing membership
   itself requires a new explicit invitation.
7. A user in another account cannot discover the room, join, send, query MAM,
   download its files or be added through the API. Raw XMPP owner/admin/invite
   packets and another user's numeric nickname must fail even for current owners.
8. Close a room and verify it disappears for all members on refresh. Direct
   messaging, directory/presence, attachments, calls and CallKit startup still work.

## Validation recorded for this change

104 Python provisioning tests, 14 installer checks and 78 real Erlang/Mnesia EUnit checks passed.
EUnit uses ejabberd 26.09 headers and real XMPP records/codecs; native MUC management
calls use explicit test-only boundary fixtures, not a live ejabberd node. Production
installation copies only the two `src` modules, never test stubs.
Standalone room/push/cache model assertions passed. XMPP service/wire-test sources,
provisioning HTTP service and controller passed isolated Dart type checks with
platform/package API stubs. Ten isolated call-startup checks passed. Full Flutter
analysis/tests, iOS build/APNs and live ejabberd integration remain deployment
checks on the Mac/server; no live server changes were performed here.
