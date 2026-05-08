# device.atebd.com/server Deployment Files

This folder is the Ubuntu/VPS-side bundle for serving the dashboard at:

```text
https://device.atebd.com/server
```

The dashboard app itself listens on local port `3000`.

## Files

- `nginx-device-atebd-server.conf` - Nginx reverse proxy for `/server`, Android bridge HTTP, Socket.IO, future chat, and future live updates.
- `dashboard.env.example` - production `.env` values for the dashboard.
- `iot-dashboard.service` - systemd service template for running `dashboard/server.js`.
- `install-ubuntu.sh` - Ubuntu installer for Nginx, the systemd unit, and the dashboard env template.
- `share-tunnel.js` - Node.js reverse tunnel helper for temporary localhost sharing before the dashboard is deployed on the VPS.

## Temporary Localhost Sharing

Run from this repo on your PC:

```bash
npm run server -- --host YOUR_VPS_IP --user root --public-url https://device.atebd.com/server --forward 3000:3001 --reconnect
```

This maps:

```text
VPS 127.0.0.1:3000 -> local PC 127.0.0.1:3001
```

Add future services:

```bash
npm run server -- --host YOUR_VPS_IP --user root --public-url https://device.atebd.com/server --forward 3000:3001,3010:3010,3011:3011 --reconnect
```

## Ubuntu VPS Setup

Upload this `server/` folder to the VPS along with the repo or copy it separately. A clean layout is:

```text
/opt/iot/server
/opt/iot/dashboard
```

Then run the installer from `/opt/iot`:

```bash
sudo bash server/install-ubuntu.sh
```

The installer places:

- Nginx site: `/etc/nginx/sites-available/device-atebd-server`
- systemd service: `/etc/systemd/system/iot-dashboard.service`
- dashboard env template: `/opt/iot/dashboard/.env` when missing

You can override install paths when needed:

```bash
sudo APP_DIR=/opt/iot/dashboard SERVICE_NAME=iot-dashboard bash server/install-ubuntu.sh
```

Manual Nginx install, if needed:

```bash
sudo cp server/nginx-device-atebd-server.conf /etc/nginx/sites-available/device-atebd-server
sudo ln -sf /etc/nginx/sites-available/device-atebd-server /etc/nginx/sites-enabled/device-atebd-server
sudo nginx -t
sudo systemctl reload nginx
```

Enable HTTPS:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d device.atebd.com
```

## Dashboard Deploy Shape

Place dashboard code at:

```text
/opt/iot/dashboard
```

Create:

```text
/opt/iot/dashboard/.env
```

Use `server/dashboard.env.example` as the starting point. Important values:

```env
PORT=3000
PUBLIC_BASE_URL=https://device.atebd.com/server
ANDROID_BRIDGE_PUBLIC_URL=https://device.atebd.com/server
PUBLIC_BRIDGE_BASE_URL=https://device.atebd.com/server
SOCKET_IO_CORS_ORIGIN=https://device.atebd.com
```

Install and start the service:

```bash
cd /opt/iot/dashboard
npm ci --omit=dev
sudo cp /opt/iot/server/iot-dashboard.service /etc/systemd/system/iot-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now iot-dashboard
sudo systemctl status iot-dashboard
```

## Notes

`SOCKET_IO_CORS_ORIGIN` must be only the origin, not `/server`, because CORS origins do not include paths.

The Nginx config accepts `/server/v1/android/bridge/*` and strips `/server` before proxying to the dashboard. This lets Android setup QR codes safely use `https://device.atebd.com/server` as the public base URL.

The Nginx config also proxies the dashboard's current absolute page paths, APIs, assets, and Socket.IO routes. That keeps the app working now while still making `/server` the public entrypoint for Android bridge URLs and future deployment links.
