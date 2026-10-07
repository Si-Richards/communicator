# VoiceHost account isolation and extension directory

For ejabberd 26.09. Install this module on **149.19.177.17 before updating the
provisioning containers**. It is the enforcement boundary; the Flutter app alone
cannot prevent cross-account traffic from another XMPP client.

## Behaviour

Provisioning owns the account membership of each full SIP JID. The dedicated
`voicehost_set_identity` HTTP command publishes its account number, SIP suffix,
display name, user-facing extension and active status into a persistent Mnesia
registry. Clients cannot assign their own account membership or edit this roster.
The command rejects a membership that disagrees with the JID's account prefix,
and rejects two active identities advertising the same extension in one account.

The roster contains only other active, provisioned messaging identities in the
requester's account. Multiple phones sharing a SIP username are one contact.
The worker uses the oldest active phone's managed display name/extension, never
the handset's installation name. If a login is `10000*213t` but the provisioned
extension is `213`, the roster advertises `213` and retains the full JID internally.
If that phone's configured extension is actually `213t`, the directory shows `213t`;
no suffix is guessed or stripped. Set the intended extension in the device editor.

Messages, presence/subscriptions and direct profile/last-activity IQs must stay
within one account. Unknown identities, disabled identities, external domains
and service subdomains are denied. Server control IQs and each user's own archive
remain available. Global discovery is restricted. Old personal roster entries
cannot expose another account. Offline deliveries are checked again.

**This first stage denies MUC rooms and external federation for these users.**
Guest conversations and approved cross-account rooms require the next stage's
explicit membership policy; enabling room defaults is not an exception here.
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

The installer asks the running node for its actual contribution-module path and
OS owner, copies only production files, and compiles with that server's headers.
It does not modify the YAML or enable the module. Never install `test/gen_mod.erl`
or the test-ebin folder into ejabberd. For a later source update, copy the updated
production files into the same sources directory and use `module_upgrade`
instead of `module_install`.

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

## Update RANDY and the app

Back up the provisioning database volume, then rebuild all three provisioning
services; the public/admin services perform the same additive SQLite migration:

```bash
cd /opt/communicator && git pull --ff-only origin feature/ejabberd-messaging && cd provisioning-server && docker compose -f docker-compose.yml up -d --build provisioning provisioning-admin messaging-worker
```

Keep `EJABBERD_API_URL=https://ejabberd.voicehost.io/api/v2`; this deployment uses
443, not 5444. Preserve the database volume and existing API credentials. Migration
retains generated passwords, publishes explicit account/extension metadata, and
bumps existing device configuration versions while awaiting the first policy sync.
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

## Verify before wider rollout

Use two accounts with the same extension numbers and a second phone sharing one
identity. Confirm each roster shows only its own account, once per identity; test
extension-only chat and a suffixed SIP login. Remove/lock the last phone and refresh
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
