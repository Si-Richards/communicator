# VoiceHost Native iOS Softphone

Native SwiftUI proof-of-concept for a VoiceHost softphone using WebRTC on iOS and the Janus SIP plugin as the SIP gateway.

## Current milestone

The first milestone deliberately focuses on the foreground call path:

- Native SwiftUI dialler/settings UI
- `URLSessionWebSocketTask` Janus signalling using `janus-protocol`
- Janus session creation and `janus.plugin.sip` attachment
- SIP registration
- WebRTC audio-only PeerConnection
- Trickle ICE to/from Janus
- Outbound calls using a JSEP offer
- Foreground incoming calls using a JSEP answer
- Ringing / early media / accepted / hangup event handling
- Mute, hold/unhold and SIP INFO DTMF
- Active-call background audio entitlement via `UIBackgroundModes = audio`

CallKit and PushKit are intentionally the next milestone. Keeping a Janus WebSocket alive is not a production incoming-call strategy when iOS suspends the app.

## Existing VoiceHost development environment

Defaults are aligned with the existing browser communicator:

- Janus WebSocket: `wss://devrtc.voicehost.io:443`
- SIP realm: `hpbx.sipconvergence.co.uk`

No Janus API secret is committed into the native client. The development UI accepts one at runtime if the Janus instance currently requires it. Do not ship a long-lived Janus infrastructure secret in an iOS binary.

## Generate the Xcode project

The repository uses XcodeGen so the project definition is reviewable rather than committing a large hand-maintained `.pbxproj`.

```bash
brew install xcodegen
cd ios
xcodegen generate
open VoiceHostSoftphone.xcodeproj
```

Xcode will resolve the pinned `stasel/WebRTC` Swift package dependency.

## First-device test

1. Open Settings in the app.
2. Enter a VoiceHost SIP extension/account and password.
3. Confirm the SIP realm or proxy if required.
4. Enter the development Janus API secret only if the development gateway currently requires it.
5. Tap **Connect & Register** and wait for **Online**.
6. Open Phone, enter a destination and place an outbound call.

Use a physical iPhone for media testing. The iOS Simulator is useful for UI/signalling work but is not representative of production audio routing.

## Next milestone

- CallKit (`CXProvider`, outgoing/incoming system calls)
- PushKit/APNs VoIP token registration
- VoiceHost backend endpoint for device/push registration
- Wake-and-route flow for incoming calls while suspended
- Proper Keychain-backed account tokens (rather than retaining SIP credentials in the view model)
- Speaker/Bluetooth route selection and audio interruption handling
- TURN configuration and mobile-network testing
- Structured diagnostics and call-quality statistics
