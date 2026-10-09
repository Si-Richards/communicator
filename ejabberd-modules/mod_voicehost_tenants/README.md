# VoiceHost account isolation, extension directory and private rooms

For the current room update, follow the [private rooms rollout guide](../../provisioning-server/MESSAGING-ROOMS.md) **before** the older feature-specific instructions below.

## Directory and presence repair

The roster hook now follows ejabberd 26.09's callback contract:
`roster_get(Items, {User, Host})` returns XMPP `roster_item` records. The old
three-argument callback failed, leaving the directory empty and preventing
presence broadcasts. Entries include the provisioned friendly name and mutual
presence subscriptions; other tenants and disabled users remain excluded.

On the ejabberd server, upgrade the installed module and restart the node:

```bash
cd /opt/voicehost-messaging && git pull --ff-only origin feature/ejabberd-messaging && bash ejabberd-modules/mod_voicehost_tenants/install.sh /opt/ejabberd-26.09/bin/ejabberdctl --upgrade && /opt/ejabberd-26.09/bin/ejabberdctl restart
```

This briefly disconnects messaging. Once the node has restarted, run
`/opt/ejabberd-26.09/bin/ejabberdctl status`. Update/rebuild the app from its
`flutter` directory:

```bash
git pull --ff-only origin feature/ejabberd-messaging && flutter pub get && flutter analyze && flutter test
```

No provisioning container, Nginx, API permission or identity migration change is
required for this repair. Existing enrolled devices and passwords remain valid.
The app probes account contacts on Directory refresh, displays local message
dates and times, and shows connection status as a compact header icon.

Test two enabled extensions in the same account: search the Directory by name
and extension, check names in conversation titles, and change Available/Away/Busy
in Messaging preferences. Disconnect one client and check Offline; another
connected device on the same extension keeps that user available. A different
tenant and a disabled identity must remain absent. Check dates in old history
and new messages. If the directory remains empty, inspect `messaging-worker`
errors and confirm both identities are published as enabled messaging users.

For standard iOS chat alerts, follow the [APNs notification rollout guide](../../provisioning-server/MESSAGING-NOTIFICATIONS.md).

For ejabberd 26.09. Install this module on **149.19.177.17 before updating the
provisioning containers**. It is the enforcement boundary; the Flutter app alone
cannot prevent cross-account traffic from another XMPP client.

## Behaviour

Provisioning owns the account membership of each canonical messaging JID. SIP
logins `10000*213`, `10000*213T` and `10000*213D` share
`10000*213@ejabberd.voicehost.io`, one stable generated messaging password and one
contact. Account numbers are numeric; extensions contain 3–5 digits. Leading zeros
are significant. Alphabetic SIP endpoint suffixes are removed from the messaging
identity without changing SIP login data or calling behaviour.

The dedicated `voicehost_set_identity` HTTP command publishes account number,
numeric extension, display name and active status into a persistent Mnesia registry.
Clients cannot assign their own membership or edit this roster. The command rejects
membership that disagrees with the JID account prefix and duplicate active directory
extensions. The roster contains only other active, provisioned messaging identities
in the requester's account. The oldest active linked phone supplies the display name.

Messages, presence/subscriptions and direct profile/last-activity IQs must stay
within one account. Unknown identities, disabled identities, external domains
and unmanaged service subdomains are denied. Server control IQs and each user's own archive
remain available. Global discovery is restricted. Old personal roster entries
cannot expose another account. Offline deliveries are checked again.

Private rooms on `rooms.@HOST@` are allowed only with explicit provisioned
account membership. Unmanaged MUC rooms, external federation and cross-account
guests remain denied. See the room guide for service configuration and roles.
Legacy/manual accounts outside the provisioned registry have no messaging access.
The administrator/API account can still use its HTTP/console commands.

## Install on the ejabberd server

Back up the current ejabberd configuration and Mnesia database using the existing
backup process. The new registry is part of Mnesia and needs to be retained in
future backups. Keep the node name, cookie, credentials and archive data unchanged.

Fetch the messaging branch into a separate checkout if this server has no copy:

```bash
git clone --single-branch --branch feature/ejabberd-messaging https://github.com/Si-Richards/communicator.git /opt/voicehost-messaging
```

Use the `ejabberdctl` belonging to the **running 26.09 installation**. The following
path is an example; if your upgrade retained a different directory, use that path:

```bash
bash /opt/voicehost-messaging/ejabberd-modules/mod_voicehost_tenants/install.sh /opt/ejabberd-26.09/bin/ejabberdctl
```

Run the installer as root on the Linux ejabberd host. It locates the running
BEAM process belonging to the supplied installation, reads its actual module
path and effective OS owner without displaying its environment, copies only
production files, and compiles with that server's headers. It honours
`CONTRIB_MODULES_PATH` and the node's runtime home. It does not require an
`ejabberdctl eval` command (26.09 does not provide one).
It does not modify the YAML or enable the module. Never install `test/gen_mod.erl`
or the test-ebin folder into ejabberd. For an existing installation, use the same installer with `--upgrade`, as shown
below. Restart after this upgrade: the new archive table and command are initialized
at module start; a configuration reload alone does not initialize them.

Merge these changes into the **existing** YAML sections. Do not duplicate
`modules` or `api_permissions`, and retain all six lifecycle permissions:

```yaml
modules:
  mod_voicehost_tenants: {}
  mod_roster:
    versioning: true
    store_current_id: false

api_permissions:
  "VoiceHost provisioning lifecycle":
    from: mod_http_api
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
      - voicehost_room_list
      - voicehost_room_create
      - voicehost_room_manage
      - voicehost_room_repair
```

`store_current_id: false` computes roster versions from the generated roster, so
existing native XMPP clients can notice membership changes. The app requests an
unversioned snapshot on login and when Directory → Refresh is tapped.

Validate/reload with the same active installation's control command:

```bash
/opt/ejabberd-26.09/bin/ejabberdctl reload_config
```

New registry entries are initially absent and access is denied until the updated
worker publishes them. Schedule this short transition: installing/enabling the
module first prevents an interval where the new app appears isolated but the
server is not. Keep the working WSS and restricted HTTPS `/api/v2` Nginx routes.
No Nginx change is required for this feature.

## Upgrade the existing endpoint-account deployment

This deployment already has the module installed. Back up the ejabberd Mnesia data
and provisioning SQLite volume together before updating. Preserve both registries,
archive data and generated passwords. Complete the ejabberd steps **before updating
RANDY**; the updated worker requires the new history command.

On **149.19.177.17**, pull the branch and upgrade the production module:

```bash
cd /opt/voicehost-messaging && git pull --ff-only origin feature/ejabberd-messaging
bash /opt/voicehost-messaging/ejabberd-modules/mod_voicehost_tenants/install.sh /opt/ejabberd-26.09/bin/ejabberdctl --upgrade
```

In the existing `/opt/ejabberd/conf/ejabberd.yml`, add
`voicehost_migrate_history` to the dedicated provisioner's `what` list, retaining
`voicehost_set_identity` and the six account lifecycle commands shown above.
Keep `mod_mam`, `mod_private`, the tenant module and the existing Mnesia backend.
Restart the active node to initialize the upgraded module, then confirm the command:

```bash
/opt/ejabberd-26.09/bin/ejabberdctl restart
/opt/ejabberd-26.09/bin/ejabberdctl status
/opt/ejabberd-26.09/bin/ejabberdctl --version 2 help voicehost_migrate_history
```

Allow the node to finish restarting before checking status. The command takes
`old_user`, `user` and `host`. No change to Nginx, TLS routes or API credentials is
needed.

The provisioning SQLite migration redirects managed devices to the canonical JID,
preserves SIP configuration, and records old JIDs in `messaging_aliases`. An existing
managed canonical account keeps its password; otherwise the oldest managed endpoint
supplies the secret. It never overwrites a manual canonical assignment or adopts an
external ejabberd account. A conflicting manual assignment stops the local migration
transaction for administrator correction; a remote ownership conflict leaves readiness
false and reports an error. Resolve ownership deliberately before retrying.

The worker removes old directory/policy access, bans retired endpoint accounts and
then copies history. Migration requires `mod_mam` with **the Mnesia archive backend**;
SQL archives return an error and keep the canonical device unready. Copies include
only same-account direct chat; foreign-account and group records remain untouched in
source archives. Source accounts, passwords and all source archives are retained.
A persistent Mnesia cursor copies up to 500 archive records per call (including all
records sharing its boundary ID); retries resume without duplicate copies. Conflicting
archive IDs fail without overwriting either account. Large histories can show
`migrating` over several worker passes. Readiness is published only after all linked
endpoint archives and the directory entry are synchronized.

Because copies retain the source, plan Mnesia capacity before a large migration.
Do not change archive backend during the handover or restore only one of the two
registries. The feature does not automatically delete historical accounts afterward.

## Update RANDY and the app

Back up the provisioning database volume, then rebuild all three provisioning
services; the public/admin services perform the same additive SQLite migration:

```bash
cd /opt/communicator && git pull --ff-only origin feature/ejabberd-messaging && cd provisioning-server && docker compose -f docker-compose.yml up -d --build provisioning provisioning-admin messaging-worker
```

Keep `EJABBERD_API_URL=https://ejabberd.voicehost.io/api/v2`; this deployment uses
443, not 5444. Preserve the database volume and existing API credentials. Migration retains source secrets, selects one shared canonical secret, and bumps
existing device configuration versions while waiting for archive and policy sync.
The worker marks devices ready only after the lifecycle and registry writes succeed.
It repairs unchanged registry entries at least once per minute while the API works;
failures retain the existing five-second to five-minute backoff. Last-device
disablement removes policy/directory access before attempting the account ban.

After replacing provisioning containers, reload the gateway Nginx so it resolves
their new Docker addresses:

```bash
cd /opt/communicator/mobile-gateway && docker compose -f docker-compose.yml exec -T nginx nginx -t && docker compose -f docker-compose.yml exec -T nginx nginx -s reload
```

Pull the same branch on the Mac, run `flutter pub get`, `flutter analyze` and
`flutter test`, then rebuild/install the app as usual. Existing device enrolments
are retained. Refresh Configuration once the worker's account status is enabled.
Messages now has Conversations and Directory tabs; search names/extensions or
enter an extension in New conversation. Names/extension labels replace raw JIDs.

Only extensions actually provisioned for managed messaging appear. This does not
import every Hosted PBX user or SIP-only phone automatically.

After the worker runs, inspect progress on RANDY without displaying passwords:

```bash
cd /opt/communicator/provisioning-server && docker compose -f docker-compose.yml logs --tail=80 messaging-worker
cd /opt/communicator/provisioning-server && docker compose -f docker-compose.yml exec -T messaging-worker python -c 'import sqlite3; from app.config import settings; c=sqlite3.connect(settings.database_path); print("Accounts:",c.execute("SELECT jid,status,error,applied_enabled FROM messaging_accounts").fetchall()); print("Aliases:",c.execute("SELECT old_jid,canonical_jid,history_done FROM messaging_aliases").fetchall()); c.close()'
```

Expected: `10000*213t`/`10000*213d` rows become `disabled`, the
`10000*213@ejabberd.voicehost.io` row becomes `enabled`, and its alias rows have
`history_done=1`. An error keeps devices unready; fix the reported API/ownership
problem and let the worker retry. Existing phones need **Refresh Configuration**,
not a fresh activation. Install the updated app to merge their local history.

## Verify before wider rollout

Use two accounts with the same extension numbers and a second phone sharing one
identity. Confirm each roster shows only its own account, once per identity; test
extension-only chat with `213`, `213T` and `213D` sharing one identity. Include
3-, 4- and 5-digit extensions with leading zeros. Confirm historical messages
and delivery state survive the handover and reconnects do not duplicate them. Remove/lock the last phone and refresh
the other phone's directory. Confirm the entry disappears and a still-open XMPP
session cannot send further traffic after the worker disables its registry entry.

Using a raw XMPP client, try cross-account messages, presence subscriptions,
vCard/last-activity IQs, global discovery, room joins and a remote-domain message.
All must be denied even if the app's UI is bypassed. No forbidden probe returns
another tenant's identity details. Verify same-account replies, receipts and own
MAM history still work. A directory failure is distinct from an empty directory.

Shared credentials still mean an individual locked phone cannot be revoked at
the server while another phone sharing that identity stays active. This existing
limit does not change; account isolation applies to the shared messaging identity.
HTTP-upload URLs are outside this stanza policy; tenant-controlled attachments
need separate file authorisation when attachment support is added.

## Automated checks

Installer regression checks run without a live server and cover runtime home,
custom module paths, effective ownership, selection of the correct installation,
ambiguous/missing node failures and the supported CLI command sequence:

```bash
python3 -m unittest discover -s test -p 'test_install_metadata.py' -v
```

Provisioning tests exercise migration/password preservation, policy API failures,
directory metadata/repair, shared identities and disable-before-ban behaviour.
EUnit runs real Mnesia and XMPP record routing with a test host registry; it does
not start or connect to a production ejabberd node. Compile against ejabberd's
headers and set ERL_LIBS to its library directory before running:

```bash
escript test/run.escript /path/to/ejabberd/include
```

The test-only host-registry stub is deliberately excluded from installation.
Live 26.09 hook wiring, TLS and API ACL acceptance must still be checked on your
server. Flutter wire fixtures cover extension resolution, suffix aliases, foreign
roster/message filtering, duplicate contacts and lock cleanup.
