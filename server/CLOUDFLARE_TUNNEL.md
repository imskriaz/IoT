# Cloudflare Tunnel

Use this when the dashboard stays on your PC or local device and Cloudflare exposes it publicly. No VPS is required.

## Quick Tunnel

This is the simplest free option.

Start the dashboard:

```bash
npm start
```

Start Cloudflare Tunnel:

```bash
npm run cloudflare
```

Copy the `https://...trycloudflare.com` URL printed by `cloudflared`.

Put that URL in `dashboard/.env` before generating Android setup QR codes:

```env
PORT=3000
PUBLIC_BASE_URL=https://your-generated-url.trycloudflare.com
ANDROID_BRIDGE_PUBLIC_URL=https://your-generated-url.trycloudflare.com
PUBLIC_BRIDGE_BASE_URL=https://your-generated-url.trycloudflare.com
SOCKET_IO_CORS_ORIGIN=https://your-generated-url.trycloudflare.com
```

Android HTTP bridge URL:

```text
https://your-generated-url.trycloudflare.com/v1/android/bridge/*
```

Browser Socket.IO URL:

```text
https://your-generated-url.trycloudflare.com/socket.io/*
```

Check:

```bash
npm run server:check -- --url https://your-generated-url.trycloudflare.com
```

## Named Tunnel

Use this only if you have your own hostname in Cloudflare.

Install `cloudflared`, then authenticate:

```bash
cloudflared tunnel login
cloudflared tunnel create dashboard-tunnel
cloudflared tunnel route dns dashboard-tunnel your-hostname.example.com
```

In Cloudflare Zero Trust, the public hostname should point to:

```text
your-hostname.example.com -> http://127.0.0.1:3000
```

Run:

```bash
npm run cloudflare -- --named --hostname your-hostname.example.com --tunnel dashboard-tunnel
```

Then use:

```env
PUBLIC_BASE_URL=https://your-hostname.example.com
ANDROID_BRIDGE_PUBLIC_URL=https://your-hostname.example.com
PUBLIC_BRIDGE_BASE_URL=https://your-hostname.example.com
SOCKET_IO_CORS_ORIGIN=https://your-hostname.example.com
```
