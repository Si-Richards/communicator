# Messaging attachments (stage 3)

The app can take a photo, choose a photo, or select a file, then show the
selection and optional caption before sending. Tap a received photo to preview
and zoom, or tap a file to save it through the operating system's file picker.
The limit is **10 MiB per file**. Cameras are supported on iOS/Android; desktop
clients use photo/file selection. Update both clients for attachment controls.

Files use the provisioning HTTPS API, not ejabberd's public HTTP upload links.
XMPP carries an opaque ID, filename, byte count, media type and SHA-256 digest
plus a text fallback. This metadata follows normal delivery/read indicators,
carbons and MAM history recovery. URLs and device credentials never enter chat
stanzas. Older clients display the text fallback.

## Access and storage

Uploads require an active device with ready, managed messaging, an owned enabled
canonical identity, and an active recipient in the same account and domain.
The server checks the device token and account again when the upload commits.
Each download authenticates the device and requires the exact conversation
pair. Another device sharing either participant's extension may download;
an unrelated extension, tenant, anonymous caller, locked/revoked device or
device reassigned to another identity cannot.

Binary data stays in the existing private `provisioning-data` volume under
`/data/messaging-attachments`. Never mount that directory into Nginx or expose
it as static files. Transfers use HTTPS; this is not end-to-end encryption.
The local encrypted chat cache stores metadata, not downloaded file bytes.
Previews stay in memory; saving creates a user-selected external copy.
OS pickers may also keep temporary selected files in their own cache.

Default retention is **30 days**, with a **1 GiB quota per account/domain**
including pending upload reservations. The messaging worker removes expired
files at approximately one-minute intervals; uploads also clean expired data.
The app reports unavailable/expired files without removing their chat history.
Already saved external copies remain under the user's control.

Optional `.env` settings (defaults work with the existing Compose volumes):

```dotenv
MESSAGING_ATTACHMENT_DIRECTORY=/data/messaging-attachments
MESSAGING_ATTACHMENT_QUOTA_BYTES=1073741824
MESSAGING_ATTACHMENT_RETENTION_DAYS=30
```

Changing the storage path requires a shared persistent mount accessible to both
provisioning and messaging-worker. Back up attachment files and their database
metadata together.

## Rollout

On RANDY, from `/opt/communicator/provisioning-server`:

```bash
git pull --ff-only origin feature/ejabberd-messaging && docker compose -f docker-compose.yml up -d --build provisioning messaging-worker
```

Merge this **new location only** into the existing public provisioning
`server` block in the mobile-gateway Nginx configuration
(`nginx/provisioning-enabled/provisioning.conf`). Preserve the existing admin
allowlist, certificates and other locations. Keep the ordinary 128k request
limit for other provisioning endpoints:

```nginx
location ^~ /api/v1/device/messaging/attachments {
    client_max_body_size 10m;
    proxy_pass http://provisioning:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

From `/opt/communicator/mobile-gateway`:

```bash
docker compose exec -T nginx nginx -t && docker compose exec -T nginx nginx -s reload
```

An anonymous request to the new route must return **401**, not the old
application's 404:

```bash
curl -sS -i --max-time 10 'https://provisioning.softphone.voicehost.io/api/v1/device/messaging/attachments/test?peer=10000%2A230%40ejabberd.voicehost.io'
```

On the Mac, from the repository's `flutter` directory:

```bash
git pull --ff-only origin feature/ejabberd-messaging && flutter pub get && ./tool/configure_ios_pushkit.sh && flutter analyze && flutter test
```

Rebuild with the usual gateway/provisioning build settings and signing.
The script adds the photo-library permission description and updates the camera
description. The native VoIP/AppDelegate template is unchanged.
The ejabberd tenant module/configuration and APNs worker need no changes for
this stage. Existing enrolled devices can use the update.

## Acceptance

1. Send a camera photo, a library photo and a PDF between two extensions in one
   account. Add a caption; check photo zoom and saving the PDF to Files.
2. Cancel selection and remove a selected draft: no message should be sent.
   A failed send retains the selection for retry while its conversation and
   device identity remain valid.
3. Check normal sent/delivered/read indicators. Open another device using the
   same extension and check synchronized attachment metadata/download access.
   Reconnect/reopen to check archive and encrypted-cache recovery.
4. Verify another tenant and an unrelated extension cannot download the ID.
   Lock/revoke/reassign the test device and verify its next request is denied.
5. Try an empty file and one larger than 10 MiB. Check rejection and no leaked
   partial upload; check Nginx permits a normal file larger than 128k.
6. Repeat an incoming CallKit answer and open the app during the call to check
   the existing startup recovery alongside messaging.

There is no durable attachment outbox: a successful upload followed by failed
XMPP delivery can leave an unused blob until retention expires. Retries may
upload another copy. Drafts are in memory and are discarded if the account
changes, access is removed or the screen/app is closed. Native Android picker
results after process termination are not automatically sent to a guessed
conversation. File types beyond JPEG/PNG/GIF/WebP are saved as files.
Editing/deletion and rooms/guest conversations remain separate work.

## Verification

Provisioning tests cover conversation/tenant boundaries, token/device state,
shared identities, commit-time access checks, size verification, atomic quotas,
filename/MIME handling and expired/interrupted upload cleanup.
The standalone Dart attachment checker exercises metadata/cache compatibility
and bounded selection reads. HTTP and XMPP wire tests are included for execution
with `flutter test`; native camera/library/file pickers and signed-device
acceptance require the development machine.
