#!/bin/sh
set -eu

incoming=${1:?incoming environment file is required}
destination=${2:?destination environment file is required}

if ! grep -q '^TIANDITU_TOKEN=' "${incoming}" && \
   [ -f "${destination}" ]; then
  token_line=$(grep '^TIANDITU_TOKEN=' "${destination}" | tail -n 1 || true)
  if [ -n "${token_line}" ]; then
    printf '%s\n' "${token_line}" >> "${incoming}"
  fi
fi

install -m 0600 "${incoming}" "${destination}"

if ! grep -q '^TIANDITU_TOKEN=' "${destination}"; then
  printf '%s\n' 'TIANDITU_TOKEN=' >> "${destination}"
fi
