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
- `share-tunnel.js` - Node.js reverse tunnel helper for temporary localhost sharing before the dashboard is deployed on the VPS.

## Temporary Localhost Sharing

Run from this repo on your PC:

```bash
node server/share-tunnel.js --host YOUR_VPS_IP --user root --public-url https://device.atebd.com/server --forward 3000:3001 --reconnect
```

This maps:

```text
VPS 127.0.0.1:3000 -> local PC 127.0.0.1:3001
```

Add future services:

```bash
node server/share-tunnel.js --host YOUR_VPS_IP --user root --public-url https://device.atebd.com/server --forward 3000:3001,3010:3010,3011:3011 --reconnect
```

## Ubuntu VPS Setup

Install base packages:

```bash
sudo apt update
sudo apt install -y nginx nodejs npm
```

Copy this folder to the VPS, then install the Nginx config:

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
sudo cp server/iot-dashboard.service /etc/systemd/system/iot-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now iot-dashboard
sudo systemctl status iot-dashboard
```

## Notes

`SOCKET_IO_CORS_ORIGIN` must be only the origin, not `/server`, because CORS origins do not include paths.

The Nginx config accepts `/server/v1/android/bridge/*` and strips `/server` before proxying to the dashboard. This lets Android setup QR codes safely use `https://device.atebd.com/server` as the public base URL.
