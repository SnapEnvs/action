#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)/$(uname -m)" != Linux/x86_64 ]]; then
  echo 'publish-image requires a Linux amd64 runner.' >&2
  exit 1
fi

directory=$(mktemp -d "${RUNNER_TEMP:?}/snapenvs-crane.XXXXXX")
trap 'rm -f "$directory/crane.tar.gz"' EXIT
curl --fail --silent --show-error --location --retry 2 \
  https://github.com/google/go-containerregistry/releases/download/v0.22.1/go-containerregistry_Linux_x86_64.tar.gz \
  --output "$directory/crane.tar.gz"
printf '%s  %s\n' '0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0' "$directory/crane.tar.gz" \
  | sha256sum --check --status
tar -xzf "$directory/crane.tar.gz" -C "$directory" crane
echo "$directory" >> "${GITHUB_PATH:?}"
