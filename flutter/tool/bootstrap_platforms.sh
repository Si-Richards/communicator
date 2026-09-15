#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is not installed or is not on PATH." >&2
  echo "Install Flutter, run 'flutter doctor', then rerun this script." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to patch the generated mobile platform files." >&2
  exit 1
fi

if [[ -d "$ROOT/ios" && -d "$ROOT/android" ]]; then
  echo "ios/ and android/ already exist. Nothing to bootstrap."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

flutter create \
  --platforms=ios,android \
  --org io.voicehost \
  --project-name voicehost_softphone \
  "$TMP/voicehost_softphone"

rm -rf "$ROOT/ios" "$ROOT/android"
cp -R "$TMP/voicehost_softphone/ios" "$ROOT/ios"
cp -R "$TMP/voicehost_softphone/android" "$ROOT/android"
cp "$TMP/voicehost_softphone/.metadata" "$ROOT/.metadata"

ROOT="$ROOT" python3 <<'PY'
import os
import plistlib
import re
from pathlib import Path

root = Path(os.environ['ROOT'])

# iOS microphone permission and established-call background audio.
plist_path = root / 'ios' / 'Runner' / 'Info.plist'
with plist_path.open('rb') as fh:
    plist = plistlib.load(fh)
plist['NSMicrophoneUsageDescription'] = 'VoiceHost needs microphone access for telephone calls.'
background = list(plist.get('UIBackgroundModes', []))
if 'audio' not in background:
    background.append('audio')
plist['UIBackgroundModes'] = background
with plist_path.open('wb') as fh:
    plistlib.dump(plist, fh, sort_keys=False)

# Android foreground audio permissions. Push/ConnectionService arrives later.
manifest_path = root / 'android' / 'app' / 'src' / 'main' / 'AndroidManifest.xml'
manifest = manifest_path.read_text()
permissions = '''
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
'''
if 'android.permission.RECORD_AUDIO' not in manifest:
    manifest = re.sub(r'(<manifest[^>]*>)', r'\1' + permissions, manifest, count=1)
manifest_path.write_text(manifest)

# flutter_webrtc requires Android API 23 or newer. Support both Gradle templates.
for filename in ('build.gradle.kts', 'build.gradle'):
    gradle_path = root / 'android' / 'app' / filename
    if not gradle_path.exists():
        continue
    gradle = gradle_path.read_text()
    gradle = re.sub(r'minSdk\s*=\s*flutter\.minSdkVersion', 'minSdk = 23', gradle)
    gradle = re.sub(r'minSdkVersion\s+flutter\.minSdkVersion', 'minSdkVersion 23', gradle)
    gradle_path.write_text(gradle)
PY

cd "$ROOT"
flutter pub get

echo
echo "Platform scaffolding generated successfully."
echo "Run: flutter run"
