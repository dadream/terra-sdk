#!/bin/sh
set -eu

set -- /app/terra_terrain_service
while IFS= read -r argument || [ -n "$argument" ]; do
  case "$argument" in
    ''|\#*) continue ;;
  esac
  case "$argument" in
    @TERRA_IMAGERY_ORIGIN@*)
      if [ -z "${TERRA_IMAGERY_ORIGIN:-}" ]; then
        echo "TERRA_IMAGERY_ORIGIN is required" >&2
        exit 2
      fi
      argument="${TERRA_IMAGERY_ORIGIN}${argument#@TERRA_IMAGERY_ORIGIN@}"
      ;;
  esac
  set -- "$@" "$argument"
done < /app/service.args

exec "$@"
