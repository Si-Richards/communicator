#!/usr/bin/env bash
# Install only the production module; never copy test stubs into ejabberd.
set -euo pipefail
ctl=${1:?Usage: bash install.sh /path/to/the/running/ejabberdctl}
[[ -x "$ctl" ]] || { echo "ejabberdctl is not executable: $ctl" >&2; exit 1; }
"$ctl" status
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
decode='import ast,sys; v=ast.literal_eval(sys.stdin.read().strip()); assert isinstance(v,str); print(v.strip())'
contrib=$("$ctl" eval 'ext_mod:modules_dir().' | python3 -c "$decode")
uid=$("$ctl" eval 'os:cmd("id -u").' | python3 -c "$decode")
gid=$("$ctl" eval 'os:cmd("id -g").' | python3 -c "$decode")
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
"$ctl" module_install mod_voicehost_tenants
echo 'Module installed. Merge the README configuration and reload ejabberd before rebuilding provisioning.'
