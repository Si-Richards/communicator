# VoiceHost Mobile Gateway

Prototype signalling service for mobile softphone background calling.

It keeps a persistent Janus `janus.plugin.sip` registration for each provisioned device, stores SIP passwords encrypted at rest, receives `incomingcall` events while the handset is suspended, sends an APNs VoIP push, and holds the Janus call while the iPhone answers through CallKit.

## Network layout

The Docker stack contains the gateway and its public NGINX reverse proxy:

```text
Internet
   |
   | HTTPS :443
   v
NGINX
   |
   | private Docker network :8080
   v
mobile-gateway
```

The Python gateway does **not** publish port 8080 to the host. Only NGINX publishes ports 80 and 443.

## Generate local secrets

```bash
cp .env.example .env
python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
openssl rand -hex 32
```

Use the Fernet output for `DEVICE_DATA_KEY` and the random hex value for `GATEWAY_API_KEY`.

Set the public hostname in `.env`:

```ini
GATEWAY_HOSTNAME=randy.voicehost.io
```

## Apple APNs

Create an APNs authentication key (`.p8`) in the Apple Developer portal and provide:

- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID` (the Runner bundle ID, without `.voip`)
- the `.p8` file at `secrets/AuthKey.p8`

Development builds normally use:

```ini
APNS_SANDBOX=true
```

## TLS certificate

NGINX expects the certificate to exist on the Docker host at:

```text
/etc/letsencrypt/live/<GATEWAY_HOSTNAME>/fullchain.pem
/etc/letsencrypt/live/<GATEWAY_HOSTNAME>/privkey.pem
```

For Randy:

```text
/etc/letsencrypt/live/randy.voicehost.io/fullchain.pem
/etc/letsencrypt/live/randy.voicehost.io/privkey.pem
```

The host's `/etc/letsencrypt` directory is mounted read-only into the NGINX container. Certificate issuance and renewal remain a host responsibility for now.

## Run

Validate the Compose configuration:

```bash
docker compose config
```

Then start:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Public health check:

```bash
curl https://randy.voicehost.io/health
```

Private gateway health check:

```bash
docker compose exec mobile-gateway \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/health').read().decode())"
```

Do not publish `8080:8080` in production.

## Flutter build

Configure the existing generated iOS project once:

```bash
cd flutter
flutter pub get
./tool/configure_ios_pushkit.sh
```

Then in Xcode on the **Runner** target add **Push Notifications** under Signing & Capabilities. Keep Background Modes enabled for Audio/VoIP and Remote notifications.

Run against Randy with:

```bash
flutter run -d <iphone-id> \
  --dart-define=VOICEHOST_GATEWAY_URL=https://randy.voicehost.io \
  --dart-define=VOICEHOST_GATEWAY_KEY=<gateway-key>
```

After the normal foreground SIP registration becomes Online, the app provisions its PushKit token and SIP account to the gateway. The gateway then owns an additional persistent Janus registration so an incoming call can wake the handset.

## Test PushKit / CallKit

Once the device has provisioned, the app/server logs show the `device_id`. Trigger:

```bash
curl -X POST \
  -H 'X-Gateway-Key: <gateway-key>' \
  https://randy.voicehost.io/v1/devices/<device-id>/test-push
```

The locked/backgrounded iPhone should immediately show the native incoming CallKit screen.

## Current prototype boundary

Foreground direct-Janus calling remains unchanged. Background incoming calls use the gateway-owned Janus handle and answer media directly between the handset and Janus. The next hardening step is to make the gateway the single signalling owner for foreground and background calls, add authenticated per-user tokens instead of the development gateway key, and move device/account storage to the production database.
