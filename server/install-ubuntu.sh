#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-your-hostname.example.com}"
APP_DIR="${APP_DIR:-/opt/iot/dashboard}"
SERVICE_NAME="${SERVICE_NAME:-iot-dashboard}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-device-atebd-server}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_NGINX="$(mktemp)"
TMP_SERVICE="$(mktemp)"

cleanup() {
  rm -f "${TMP_NGINX}" "${TMP_SERVICE}"
}
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo:"
  echo "  sudo bash server/install-ubuntu.sh"
  exit 1
fi

echo "Installing Ubuntu packages..."
apt update
apt install -y nginx nodejs npm

echo "Installing Nginx site for ${DOMAIN}/server..."
sed "s/server_name device\.atebd\.com;/server_name ${DOMAIN};/" \
  "${SCRIPT_DIR}/nginx-device-atebd-server.conf" > "${TMP_NGINX}"
install -m 0644 "${TMP_NGINX}" "/etc/nginx/sites-available/${NGINX_SITE_NAME}"
ln -sf "/etc/nginx/sites-available/${NGINX_SITE_NAME}" "/etc/nginx/sites-enabled/${NGINX_SITE_NAME}"

echo "Preparing dashboard directory at ${APP_DIR}..."
mkdir -p "${APP_DIR}"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${SCRIPT_DIR}/dashboard.env.example" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  echo "Created ${APP_DIR}/.env from dashboard.env.example"
  echo "Edit real secrets before starting production traffic:"
  echo "  sudo nano ${APP_DIR}/.env"
fi

echo "Installing systemd service ${SERVICE_NAME}..."
sed \
  -e "s#WorkingDirectory=/opt/iot/dashboard#WorkingDirectory=${APP_DIR}#" \
  -e "s#EnvironmentFile=/opt/iot/dashboard/.env#EnvironmentFile=${APP_DIR}/.env#" \
  "${SCRIPT_DIR}/iot-dashboard.service" > "${TMP_SERVICE}"
install -m 0644 "${TMP_SERVICE}" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

echo "Validating and reloading Nginx..."
nginx -t
systemctl reload nginx

echo ""
echo "Installed VPS server bundle."
echo ""
echo "Next steps:"
echo "  1. Upload/copy dashboard app files into ${APP_DIR}"
echo "  2. Run: cd ${APP_DIR} && npm ci --omit=dev"
echo "  3. Edit: sudo nano ${APP_DIR}/.env"
echo "  4. Start: sudo systemctl enable --now ${SERVICE_NAME}"
echo "  5. HTTPS: sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d ${DOMAIN}"
echo ""
