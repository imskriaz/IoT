# Localhost Dashboard Through Ubuntu VPS

Use this when the dashboard runs on your PC, but Android phones need to reach it from outside that PC. Production deployment for `device.atebd.com` uses app port `3000`; local development may still run on `3001`.

## Keep On The Dashboard PC

In `dashboard/.env`:

```env
PORT=3000
ANDROID_BRIDGE_PUBLIC_URL=https://device.atebd.com/server
PUBLIC_BRIDGE_BASE_URL=https://device.atebd.com/server
SOCKET_IO_CORS_ORIGIN=https://device.atebd.com
```

For local development on the PC, you can keep `PORT=3001` and map VPS port `3000` to local port `3001` with the tunnel.

Start the dashboard:

```powershell
cd D:\Projects\IoT\dashboard
npm start
```

Open the reverse tunnel with Node.js and keep the process running:

```powershell
cd D:\Projects\IoT
npm run server -- --host YOUR_VPS_IP --user root --preset dashboard --reconnect
```

If SSH uses a key:

```powershell
npm run server -- --host YOUR_VPS_IP --user root --key C:\Users\skria\.ssh\id_rsa --preset dashboard --reconnect
```

If your local dashboard is still on `3001`, use:

```powershell
npm run server -- --host YOUR_VPS_IP --user root --public-url https://device.atebd.com/server --forward 3000:3001 --reconnect
```

For more services later, add more `remote:local` ports to the same tunnel:

```powershell
npm run server -- `
  --host YOUR_VPS_IP `
  --user root `
  --preset all `
  --skip-missing `
  --reconnect
```

For daily use, save the VPS details once:

```powershell
Copy-Item server\tunnel.config.example.json server\tunnel.config.json
notepad server\tunnel.config.json
npm run server -- --config server/tunnel.config.json
```

After the tunnel starts, check HTTP and Socket.IO from another terminal:

```powershell
npm run server:check -- --url https://device.atebd.com/server
```

If you saved `server\tunnel.config.json`, the checker can reuse it:

```powershell
npm run server:check -- --config server/tunnel.config.json
```

During HTTPS setup, redirects can be followed explicitly:

```powershell
npm run server:check -- --url http://device.atebd.com/server --follow-redirects
```

If the checker redirects to `wp-signup.php`, the domain is still hitting a WordPress catch-all. Point `device.atebd.com` to the IoT VPS/Nginx host before generating Android QR codes.

Recommended port meaning:

- `3000:3000` deployed dashboard on VPS
- `3000:3001` temporary tunnel from VPS production port to local dev dashboard
- `3010:3010` future chat service
- `3011:3011` future live-update/SSE/WebSocket service

## Keep On The VPS

The VPS is Ubuntu. Install Nginx and copy `server/nginx-device-atebd-server.conf` to:

```bash
sudo apt update
sudo apt install -y nginx
sudo cp server/nginx-device-atebd-server.conf /etc/nginx/sites-available/device-atebd-server
sudo ln -sf /etc/nginx/sites-available/device-atebd-server /etc/nginx/sites-enabled/device-atebd-server
sudo nginx -t
sudo systemctl reload nginx
```

For HTTPS:

```bash
sudo certbot --nginx -d device.atebd.com
```

## Traffic Path

Android app:

```text
https://device.atebd.com/server/v1/android/bridge/*
```

Browser dashboard WebSocket:

```text
https://device.atebd.com/socket.io/*
```

Future chat service:

```text
https://device.atebd.com/chat/*
```

Future live update service:

```text
https://device.atebd.com/live/*
```

VPS Nginx forwards both to:

```text
127.0.0.1:3000 on VPS
```

The SSH reverse tunnel forwards that to:

```text
127.0.0.1:3001 on your dashboard PC when using the temporary local tunnel
```

## Important

Generate Android setup QR codes only after `ANDROID_BRIDGE_PUBLIC_URL` is set. Otherwise the QR may contain `localhost`, which works only on the dashboard PC and not on the Android phone.

The tunnel script is generic. It can share any local TCP/HTTP/WebSocket service through the VPS by adding another `--forward remotePort:localPort` mapping and a matching Nginx `location` on the VPS.

The PowerShell script is kept only as a Windows convenience. Prefer the Node.js script because it works the same from Windows, Linux, Ubuntu VPS shells, CI, and future service scripts.
