#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
HOST=${TERRA_LIGHTHOUSE_HOST:-terra}
DOMAIN=${TERRA_LIGHTHOUSE_DOMAIN:-terra.tapirs.top}
PUBLIC_IP=${TERRA_LIGHTHOUSE_IP:-49.233.185.96}
PUBLIC_ORIGIN=${TERRA_LIGHTHOUSE_PUBLIC_ORIGIN:-http://${PUBLIC_IP}}
OUTPUT_DIR="${ROOT_DIR}/viewer_verify_output/lighthouse"
SITE_DIR=$(realpath -m \
  "${TERRA_PRODUCT_SITE_OUTPUT:-${ROOT_DIR}/workspace_old/site}")
TAG=${1:-$(cat "${OUTPUT_DIR}/image-tag.txt" 2>/dev/null || true)}

if [[ ! "${TAG}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Missing or invalid image tag; prepare the images first." >&2
  exit 2
fi
if [[ ! "${HOST}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid SSH host alias: ${HOST}" >&2
  exit 2
fi
if [ "${DOMAIN}" != "terra.tapirs.top" ]; then
  echo "This deployment is pinned to terra.tapirs.top." >&2
  exit 2
fi
if [ "${PUBLIC_IP}" != "49.233.185.96" ]; then
  echo "This deployment is pinned to 49.233.185.96." >&2
  exit 2
fi
case "${PUBLIC_ORIGIN}" in
  "http://${PUBLIC_IP}"|"https://${DOMAIN}") ;;
  *)
    echo "Unsupported public origin: ${PUBLIC_ORIGIN}" >&2
    exit 2
    ;;
esac

bash "${ROOT_DIR}/scripts/verify_product_site.sh"
if [ ! -s "${SITE_DIR}/index.html" ] || \
   [ ! -s "${SITE_DIR}/demo/globe/index.html" ]; then
  echo "Product site build is incomplete: ${SITE_DIR}" >&2
  exit 2
fi

BUNDLE="${OUTPUT_DIR}/terra-images-${TAG}.tar.gz"
if [ ! -f "${BUNDLE}" ] || [ ! -f "${BUNDLE}.sha256" ]; then
  echo "Missing image bundle or checksum: ${BUNDLE}" >&2
  exit 2
fi
(
  cd "${OUTPUT_DIR}"
  sha256sum --check "$(basename "${BUNDLE}.sha256")"
)

REMOTE_STAGE="/tmp/terra-deploy-${TAG}"
REMOTE_SITE_DIR="/srv/terra/sites/${TAG}"
LOCAL_ENV=$(mktemp)
REMOTE_STAGE_CREATED=0
cleanup() {
  rm -f "${LOCAL_ENV}"
  if [ "${REMOTE_STAGE_CREATED}" -eq 1 ]; then
    ssh "${HOST}" rm -rf "${REMOTE_STAGE}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
chmod 0600 "${LOCAL_ENV}"
{
  printf 'TERRA_IMAGE_TAG=%s\n' "${TAG}"
  printf 'TERRA_LIGHTHOUSE_IP=%s\n' "${PUBLIC_IP}"
  printf 'TERRA_SITE_DIR=%s\n' "${REMOTE_SITE_DIR}"
  printf 'TERRA_PUBLIC_ORIGIN=%s\n' "${PUBLIC_ORIGIN}"
  if [[ -v TERRA_TIANDITU_TOKEN ]]; then
    printf 'TIANDITU_TOKEN=%s\n' "${TERRA_TIANDITU_TOKEN}"
  fi
} > "${LOCAL_ENV}"

ssh "${HOST}" mkdir -p "${REMOTE_STAGE}"
REMOTE_STAGE_CREATED=1
scp "${BUNDLE}" "${HOST}:${REMOTE_STAGE}/terra-images.tar.gz"
scp -r "${ROOT_DIR}/deploy/lighthouse" "${HOST}:${REMOTE_STAGE}/deploy"
scp -r "${SITE_DIR}" "${HOST}:${REMOTE_STAGE}/site"
scp "${LOCAL_ENV}" "${HOST}:${REMOTE_STAGE}/terra.env"

ssh "${HOST}" sudo install -d -m 0755 /opt/terra/deploy
ssh "${HOST}" sudo cp -a "${REMOTE_STAGE}/deploy/." /opt/terra/deploy/
ssh "${HOST}" sudo sh /opt/terra/deploy/install_env.sh \
  "${REMOTE_STAGE}/terra.env" /opt/terra/.env
ssh "${HOST}" rm -f "${REMOTE_STAGE}/terra.env"
ssh "${HOST}" sudo install -d -m 0755 \
  /srv/terra/data /srv/terra/cache/tianditu "${REMOTE_SITE_DIR}"
ssh "${HOST}" sudo cp -a "${REMOTE_STAGE}/site/." "${REMOTE_SITE_DIR}/"
ssh "${HOST}" sudo chmod -R a+rX "${REMOTE_SITE_DIR}"
ssh "${HOST}" sudo python3 /opt/terra/deploy/verify_data.py \
  --data-root /srv/terra/data \
  --manifest /opt/terra/deploy/data_manifest.json
ssh "${HOST}" sudo docker load -i "${REMOTE_STAGE}/terra-images.tar.gz"
ssh "${HOST}" sudo docker compose \
  --env-file /opt/terra/.env \
  -f /opt/terra/deploy/compose.yaml up -d --remove-orphans
ssh "${HOST}" rm -rf "${REMOTE_STAGE}"
REMOTE_STAGE_CREATED=0

if [ "${TERRA_LIGHTHOUSE_SKIP_VERIFY:-0}" != "1" ]; then
  VERIFY_LOG="${OUTPUT_DIR}/deployment-verify.log"
  verified=0
  for _ in $(seq 1 12); do
    if TERRA_LIGHTHOUSE_ORIGIN="${PUBLIC_ORIGIN}" \
        bash "${ROOT_DIR}/scripts/verify_lighthouse_services.sh" \
        >"${VERIFY_LOG}" 2>&1; then
      verified=1
      break
    fi
    sleep 3
  done
  cat "${VERIFY_LOG}"
  if [ "${verified}" -ne 1 ]; then
    echo "Lighthouse deployment verification failed." >&2
    exit 1
  fi
fi

echo "Lighthouse deployment passed for ${PUBLIC_ORIGIN} with tag ${TAG}."
echo "HTTPS domain remains configured at https://${DOMAIN} for post-filing use."
