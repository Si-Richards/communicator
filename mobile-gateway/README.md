# VoiceHost Mobile Gateway

Prototype signalling service for mobile softphone background calling.

It keeps a persistent Janus `janus.plugin.sip` registration for each provisioned device, stores SIP passwords encrypted at rest, receives `incomingcall` events while the handset is suspended, sends an APNs VoIP push, and holds the Janus call while the iPhone answers through CallKit.

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

## Apple APNs

Create an APNs authentication key (`.p8`) in the Apple Developer portal and provide:

- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID` (the Runner bundle ID, without `.voip`)
- the `.p8` file at `secrets/AuthKey.p8`

Development builds normally use `APNS_SANDBOX=true`.

## Run

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/health
```

Expose it behind HTTPS before using it from the iPhone.

## Flutter build

Configure the existing generated iOS project once:

```bash
cd flutter
flutter pub get
./tool/configure_ios_pushkit.sh
```

Then in Xcode on the **Runner** target add **Push Notifications** under Signing & Capabilities. Keep Background Modes enabled for Audio/VoIP and Remote notifications.

Run with the gateway location and development API key supplied as Dart defines:

```bash
flutter run -d <iphone-id> \
  --dart-define=VOICEHOST_GATEWAY_URL=https://mobile-dev.voicehost.io \
  --dart-define=VOICEHOST_GATEWAY_KEY=<gateway-key>
```

After the normal foreground SIP registration becomes Online, the app provisions its PushKit token and SIP account to this gateway. The gateway then owns an additional persistent Janus registration so an incoming call can wake the handset.

## Test just PushKit/CallKit

Once the device has provisioned, the server log shows the `device_id`. Trigger:

```bash
curl -X POST \
  -H 'X-Gateway-Key: <gateway-key>' \
  https://mobile-dev.voicehost.io/v1/devices/<device-id>/test-push
```

The locked/backgrounded iPhone should immediately show the native incoming CallKit screen.

## Current prototype boundary

Foreground direct-Janus calling remains unchanged. Background incoming calls use the gateway-owned Janus handle and answer media directly between the handset and Janus. The next hardening step is to make the gateway the single signalling owner for foreground and background calls, add authenticated per-user tokens instead of the development gateway key, and move device/account storage to the production database.
