#!/usr/bin/env bash
# Install only the production module; never copy test stubs into ejabberd.
set -euo pipefail
ctl=${1:?Usage: bash install.sh /path/to/the/running/ejabberdctl}
case ${2:-install} in
  install) operation=module_install;;
  --upgrade) operation=module_upgrade;;
  *) echo 'Second argument must be --upgrade or omitted' >&2; exit 1;;
esac
[[ -x "$ctl" ]] || { echo "ejabberdctl is not executable: $ctl" >&2; exit 1; }
status=$("$ctl" status)
printf '%s\n' "$status"
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# ejabberdctl 26.09 has no eval command. Inspect only this installation's
# running Linux node; keep credentials and the rest of its environment private.
metadata=$(python3 "$root/install_metadata.py" "$ctl" "$status")
mapfile -t values <<< "$metadata"
[[ ${#values[@]} = 3 ]] || { echo 'Invalid node metadata' >&2; exit 1; }
contrib=${values[0]}; uid=${values[1]}; gid=${values[2]}
[[ "$contrib" = /* && "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || { echo "Could not resolve the node's module path or owner" >&2; exit 1; }
package="$contrib/sources/mod_voicehost_tenants"
new_contrib=0; [[ -d "$contrib" ]] || new_contrib=1
new_sources=0; [[ -d "$contrib/sources" ]] || new_sources=1
mkdir -p "$package/src"
cp "$root/src/mod_voicehost_tenants.erl" "$package/src/"
cp "$root/mod_voicehost_tenants.spec" "$root/README.md" "$root/COPYING" "$package/"
if [[ $(id -u) = 0 ]]; then
  if [[ "$new_contrib" = 1 ]]; then chown "$uid:$gid" "$contrib"; fi
  if [[ "$new_sources" = 1 ]]; then chown "$uid:$gid" "$contrib/sources"; fi
  chown -R "$uid:$gid" "$package"
fi
# Installing compiles against the running server's own headers/libraries.
# Existing installs must be upgraded explicitly; do not hide install errors.
"$ctl" "$operation" mod_voicehost_tenants
echo 'Module compiled. Merge the README configuration and restart ejabberd before rebuilding provisioning.'
