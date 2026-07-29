#!/bin/sh
set -eu

set -- /app/terra_terrain_service
while IFS= read -r argument || [ -n "$argument" ]; do
  case "$argument" in
    ''|\#*) continue ;;
  esac
  set -- "$@" "$argument"
done < /app/service.args

exec "$@"
