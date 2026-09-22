#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS="$ROOT/ios"

if [[ ! -d "$IOS/Runner" ]]; then
  echo "ios/Runner not found. Run flutter create --platforms=ios . first." >&2
  exit 1
fi

cp "$ROOT/tool/AppDelegate.PushKit.swift" "$IOS/Runner/AppDelegate.swift"
cp "$ROOT/tool/LaunchScreen.voicehost.storyboard" "$IOS/Runner/Base.lproj/LaunchScreen.storyboard"

ROOT="$ROOT" python3 <<'PY'
import os
import plistlib
from pathlib import Path

root = Path(os.environ['ROOT'])
plist_path = root / 'ios' / 'Runner' / 'Info.plist'
with plist_path.open('rb') as fh:
    plist = plistlib.load(fh)
plist['NSMicrophoneUsageDescription'] = 'VoiceHost needs microphone access for telephone calls.'
plist['NSContactsUsageDescription'] = 'VoiceHost uses your contacts so you can find and dial telephone numbers from the app.'
modes = list(plist.get('UIBackgroundModes', []))
for mode in ('audio', 'voip', 'remote-notification'):
    if mode not in modes:
        modes.append(mode)
plist['UIBackgroundModes'] = modes

url_types = list(plist.get('CFBundleURLTypes', []))
scheme_name = 'voicehost-softphone'
has_scheme = any(
    scheme_name in item.get('CFBundleURLSchemes', [])
    for item in url_types
    if isinstance(item, dict)
)
if not has_scheme:
    url_types.append({
        'CFBundleURLName': 'io.voicehost.softphone',
        'CFBundleURLSchemes': [scheme_name],
    })
plist['CFBundleURLTypes'] = url_types

with plist_path.open('wb') as fh:
    plistlib.dump(plist, fh, sort_keys=False)
PY

cat <<'EOF'
PushKit source, VoiceHost launch screen, and Info.plist configured.

One Xcode capability step remains (Apple controls provisioning):
  Runner target -> Signing & Capabilities -> + Capability -> Push Notifications

Keep Background Modes enabled for Audio/VoIP and Remote notifications.
Then run: flutter pub get && flutter run
EOF
