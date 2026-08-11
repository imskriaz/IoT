# Localhost Dashboard Through VPS

This is a generic fallback only. The preferred free setup is [Cloudflare Tunnel](../../../server/CLOUDFLARE_TUNNEL.md).

If a VPS is ever used again, replace the placeholders below with that VPS public URL.

```env
PORT=3000
ANDROID_BRIDGE_PUBLIC_URL=https://your-vps-host.example.com/server
PUBLIC_BRIDGE_BASE_URL=https://your-vps-host.example.com/server
SOCKET_IO_CORS_ORIGIN=https://your-vps-host.example.com
```

For the current no-VPS Cloudflare setup, do not use `/server`; use the generated Cloudflare URL directly.
