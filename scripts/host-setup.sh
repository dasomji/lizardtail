#!/usr/bin/env bash
set -euo pipefail
# Run as the ordinary development user. Never grant access to rootful Docker.
missing=0
for binary in newuidmap newgidmap; do
  if ! command -v "$binary" >/dev/null; then
    echo "Missing host prerequisite: $binary" >&2
    missing=1
  fi
done
if (( missing )); then
  echo 'A host administrator must install the uidmap package (Debian/Ubuntu: sudo apt-get install uidmap).' >&2
  echo 'Then rerun scripts/host-setup.sh as the development user.' >&2
  exit 1
fi
user_name=$(id -un)
if ! awk -F: -v u="$user_name" '$1==u && $3>=65536 {found=1} END {exit !found}' /etc/subuid ||
   ! awk -F: -v u="$user_name" '$1==u && $3>=65536 {found=1} END {exit !found}' /etc/subgid; then
  echo 'An administrator must assign at least 65536 subordinate UIDs and GIDs to this user.' >&2
  exit 1
fi
if ! docker --context rootless info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  dockerd-rootless-setuptool.sh install --force
fi
systemctl --user enable --now docker.service
docker --context rootless info --format '{{json .SecurityOptions}}'
echo 'Rootless Docker ready. Existing rootful Docker services have not been modified.'
