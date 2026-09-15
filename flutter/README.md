# VoiceHost Flutter Softphone

Cross-platform VoiceHost softphone for iOS and Android using **Flutter**, **WebRTC** and the **Janus SIP plugin**.

This branch is the Flutter successor to the native Swift proof-of-concept under `../ios/`. The native client remains in the repository as a useful protocol/reference implementation.

## Current milestone

Implemented in the shared Dart codebase:

- Janus WebSocket connection with the required `janus-protocol` subprotocol
- Janus session creation and `janus.plugin.sip` attachment
- SIP REGISTER / unregister flow
- Foreground outgoing audio calls
- Foreground incoming calls
- JSEP offer/answer handling
- Trickle ICE with candidate buffering
- Early media / ringing / accepted / hangup call states
- Mute, hold/unhold, speakerphone and SIP INFO DTMF
- Persistent Do Not Disturb with automatic SIP 486 decline
- Persistent call history with redial/delete/clear
- SIP `message-summary` SUBSCRIBE/NOTIFY voicemail MWI
- Configurable voicemail access number / feature code
- SIP password and Janus development secret stored with secure platform storage

Not yet implemented:

- iOS CallKit / PushKit incoming calls while suspended or terminated
- Android Telecom / ConnectionService and FCM incoming calls
- VoiceHost visual voicemail API (list/play/delete/transcription)
- Contacts integration
- Production short-lived authentication replacing a Janus API secret
- VoiceHost TURN/STUN policy and production network hardening

## Requirements

Install Flutter stable and confirm the mobile toolchains are healthy:

```bash
flutter --version
flutter doctor
```

For iOS, Xcode and a configured Apple development team are required. For Android, install Android Studio / Android SDK and accept the SDK licences.

## First setup

This repository intentionally does **not** commit Flutter-generated `ios/` and `android/` scaffolding yet. Generating those files from your installed Flutter version avoids pinning stale Xcode/Gradle templates while the prototype is moving quickly.

From this directory run:

```bash
./tool/bootstrap_platforms.sh
```

The script:

1. Generates current iOS and Android Flutter platform projects in a temporary directory.
2. Copies only the platform scaffolding into this project.
3. Adds iOS microphone/background-audio configuration.
4. Adds Android audio/network permissions and sets minSdk 23 for `flutter_webrtc`.
5. Runs `flutter pub get`.

Then connect a physical device and run:

```bash
flutter devices
flutter run
```

A physical iPhone or Android handset is strongly recommended for WebRTC audio testing.

## VoiceHost development defaults

The app starts with:

```text
Janus WebSocket: wss://devrtc.voicehost.io:443
SIP realm:       hpbx.sipconvergence.co.uk
Plugin:          janus.plugin.sip
```

No Janus API secret is compiled into the application. During development enter it in **Settings** if the current Janus server requires one.

## First test

1. Open **Settings**.
2. Enter nickname, SIP username/extension and SIP password.
3. Confirm the Janus URL and SIP realm.
4. Tap **Save, Connect & Register**.
5. Confirm the status becomes **Online**.
6. Open **Phone**, dial an internal extension first, and place a call.
7. Check the console for `[VoiceHost]` WebRTC/Janus diagnostics if media does not establish.

The recommended first media test is an internal VoiceHost extension-to-extension call before adding PSTN routing to the test path.

## Architecture

```text
Flutter UI
   |
PhoneController
   |-------------------- CallHistoryRepository
   |-------------------- SettingsRepository
   |
   +-- JanusClient -- WSS / janus-protocol
   |      |
   |      +-- JanusSipService -- janus.plugin.sip
   |
   +-- WebRtcService -- flutter_webrtc
              |
           WebRTC audio
              |
            Janus
              |
          SIP / RTP
              |
        VoiceHost platform
```

## Voicemail

On successful SIP registration the client subscribes to:

```text
Event: message-summary
Accept: application/simple-message-summary
```

The app parses bodies such as:

```text
Messages-Waiting: yes
Voice-Message: 2/7 (0/0)
```

and exposes the new/saved counts in the Voicemail tab. Individual visual-voicemail management will be added once the VoiceHost voicemail storage/API endpoint is wired into the mobile client.

## DND behaviour

DND is currently **device-side**. An incoming Janus SIP call is declined with `486 Busy Here` and added to Recents as missed.

For production, the preferred design is to synchronize DND with the VoiceHost platform so iOS, Android, desk phones and the web client share one account/extension state.

## Production mobile calling roadmap

Foreground calling is deliberately being proved first. Background incoming calls should not depend on a permanently alive Janus WebSocket.

The production model will be:

```text
VoiceHost call event
       |
       +--> APNs VoIP Push --> iOS CallKit
       |
       +--> FCM ------------> Android Telecom / ConnectionService
                                |
                           reconnect Janus
                                |
                           establish media
```

That work should begin after foreground registration, outgoing audio and incoming audio have been validated on physical iOS and Android devices.
