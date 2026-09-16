#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS="$ROOT/ios"

if [[ ! -d "$IOS/Runner" ]]; then
  echo "ios/Runner not found. Run flutter create --platforms=ios . first." >&2
  exit 1
fi

cp "$ROOT/tool/AppDelegate.PushKit.swift" "$IOS/Runner/AppDelegate.swift"

ROOT="$ROOT" python3 <<'PY'
import os
import plistlib
from pathlib import Path

root = Path(os.environ['ROOT'])
plist_path = root / 'ios' / 'Runner' / 'Info.plist'
with plist_path.open('rb') as fh:
    plist = plistlib.load(fh)
plist['NSMicrophoneUsageDescription'] = 'VoiceHost needs microphone access for telephone calls.'
modes = list(plist.get('UIBackgroundModes', []))
for mode in ('audio', 'voip', 'remote-notification'):
    if mode not in modes:
        modes.append(mode)
plist['UIBackgroundModes'] = modes
with plist_path.open('wb') as fh:
    plistlib.dump(plist, fh, sort_keys=False)
PY

cat <<'EOF'
PushKit source and Info.plist configured.

One Xcode capability step remains (Apple controls provisioning):
  Runner target -> Signing & Capabilities -> + Capability -> Push Notifications

Keep Background Modes enabled for Audio/VoIP and Remote notifications.
Then run: flutter pub get && flutter run
EOF
