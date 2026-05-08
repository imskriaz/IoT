# Cloudflare Server Tools

The active free setup is:

```text
local dashboard -> cloudflared -> Cloudflare public URL
```

No VPS is required. The dashboard listens on local port `3000`.

## Files

- `cloudflare-tunnel.js` - Cloudflare Tunnel runner for no-VPS public access.
- `cloudflare.config.example.json` - saved Cloudflare tunnel runner settings.
- `CLOUDFLARE_TUNNEL.md` - no-VPS setup guide.
- `check-server.js` - HTTP and Socket.IO reachability checker.
- `diagnose-vps.js`, `share-tunnel.js`, `nginx-device-atebd-server.conf`, `install-ubuntu.sh` - generic fallback tools only if a VPS is used later.

## Quick Cloudflare Tunnel

Start the dashboard:

```bash
npm start
```

In another terminal:

```bash
npm run cloudflare
```

`cloudflared` prints a URL like:

```text
https://something-random.trycloudflare.com
```

Use that URL in `dashboard/.env` before generating Android QR codes:

```env
PUBLIC_BASE_URL=https://something-random.trycloudflare.com
ANDROID_BRIDGE_PUBLIC_URL=https://something-random.trycloudflare.com
PUBLIC_BRIDGE_BASE_URL=https://something-random.trycloudflare.com
SOCKET_IO_CORS_ORIGIN=https://something-random.trycloudflare.com
```

Check it:

```bash
npm run server:check -- --url https://something-random.trycloudflare.com
```

## Named Cloudflare Tunnel

Use this only if you have a hostname in Cloudflare.

```bash
npm run cloudflare -- --named --hostname your-hostname.example.com --tunnel dashboard-tunnel
```

The local service target should be:

```text
http://127.0.0.1:3000
```

Full guide: [CLOUDFLARE_TUNNEL.md](D:/Projects/IoT/server/CLOUDFLARE_TUNNEL.md)
