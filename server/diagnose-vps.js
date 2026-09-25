#!/usr/bin/env node
'use strict';

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const { spawnSync } = require('child_process');

const DEFAULT_DOMAIN = '';
const DEFAULT_URL = process.env.ANDROID_BRIDGE_PUBLIC_URL || process.env.PUBLIC_BRIDGE_BASE_URL || '';

function printUsage() {
  console.log(`Usage:
  node server/diagnose-vps.js [options]

Options:
  --domain your-hostname.example.com
  --url https://your-tunnel.trycloudflare.com
  --origin-ip YOUR_VPS_IP
  --app-port 3000
  --service iot-dashboard
  --site device-atebd-server
  --timeout 5000
  --skip-local
  --json

Examples:
  npm --prefix /opt/iot/server run diagnose
  npm run server:diagnose -- --url https://your-tunnel.trycloudflare.com --skip-local
`);
}

function parseArgs(argv) {
  const options = {
    domain: DEFAULT_DOMAIN,
    url: DEFAULT_URL,
    originIp: '',
    appPort: 3000,
    service: 'iot-dashboard',
    site: 'device-atebd-server',
    timeout: 5000,
    skipLocal: false,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--domain') {
      options.domain = next();
    } else if (arg === '--url') {
      options.url = next();
    } else if (arg === '--origin-ip') {
      options.originIp = next();
    } else if (arg === '--app-port') {
      options.appPort = Number(next());
    } else if (arg === '--service') {
      options.service = next();
    } else if (arg === '--site') {
      options.site = next();
    } else if (arg === '--timeout') {
      options.timeout = Number(next());
    } else if (arg === '--skip-local') {
      options.skipLocal = true;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.appPort) || options.appPort < 1 || options.appPort > 65535) {
    throw new Error('--app-port must be a valid TCP port.');
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 500) {
    throw new Error('--timeout must be at least 500 milliseconds.');
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true
  });
  return {
    command: `${command} ${args.join(' ')}`.trim(),
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    missing: result.error?.code === 'ENOENT',
    error: result.error?.message || ''
  };
}

function localIps() {
  const ips = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry.internal && entry.family === 'IPv4') {
        ips.add(entry.address);
      }
    }
  }
  return Array.from(ips);
}

async function resolveDomain(domain) {
  try {
    const rows = await dns.lookup(domain, { all: true });
    return rows.map(row => row.address);
  } catch (error) {
    return { error: error.message };
  }
}

function checkTcp(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function requestUrl(value, timeout) {
  return new Promise((resolve) => {
    const url = new URL(value);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET',
      timeout,
      headers: { 'User-Agent': 'iot-vps-diagnose/1.0' }
    }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 500,
          status: res.statusCode || 0,
          location: res.headers.location || ''
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeout}ms`)));
    req.on('error', error => resolve({ ok: false, status: 0, error: error.message }));
    req.end();
  });
}

function publicUrls(baseUrl) {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const health = new URL(base.toString());
  health.pathname = `${prefix}/health`;
  const socket = new URL(base.toString());
  socket.pathname = '/socket.io/';
  socket.searchParams.set('EIO', '4');
  socket.searchParams.set('transport', 'polling');
  return { health: health.toString(), socket: socket.toString() };
}

async function collect(options) {
  const dnsAddresses = await resolveDomain(options.domain);
  const ips = localIps();
  const urls = publicUrls(options.url);
  const checks = [];

  checks.push({
    name: 'dns',
    ok: Array.isArray(dnsAddresses) && dnsAddresses.length > 0,
    detail: dnsDetail(dnsAddresses)
  });

  if (options.originIp) {
    const matchesOrigin = Array.isArray(dnsAddresses) && dnsAddresses.includes(options.originIp);
    const proxied = Array.isArray(dnsAddresses) && dnsAddresses.some(isLikelyCloudflareIp);
    checks.push({
      name: 'dns-origin',
      ok: matchesOrigin || proxied,
      detail: matchesOrigin
        ? `domain resolves to origin ${options.originIp}`
        : proxied
          ? `Cloudflare/proxy DNS; verify origin A record points to ${options.originIp}`
          : `expected ${options.originIp}, got ${Array.isArray(dnsAddresses) ? dnsAddresses.join(', ') : 'unresolved'}`
    });
  }

  if (!options.skipLocal) {
    checks.push({
      name: 'dns-local-match',
      ok: Array.isArray(dnsAddresses) && dnsAddresses.some(ip => ips.includes(ip)),
      detail: `domain=${Array.isArray(dnsAddresses) ? dnsAddresses.join(',') : 'unresolved'} local=${ips.join(',') || 'none'}`
    });
    checks.push({
      name: 'app-port',
      ok: await checkTcp('127.0.0.1', options.appPort, options.timeout),
      detail: `127.0.0.1:${options.appPort}`
    });

    const active = run('systemctl', ['is-active', options.service]);
    checks.push({ name: 'systemd-active', ok: active.ok, detail: active.stdout || active.stderr || active.error });
    const enabled = run('systemctl', ['is-enabled', options.service]);
    checks.push({ name: 'systemd-enabled', ok: enabled.ok, detail: enabled.stdout || enabled.stderr || enabled.error });
    const nginxTest = run('nginx', ['-t']);
    checks.push({ name: 'nginx-test', ok: nginxTest.ok, detail: nginxTest.stderr || nginxTest.stdout || nginxTest.error });
    const nginxDump = run('nginx', ['-T']);
    const dump = `${nginxDump.stdout}\n${nginxDump.stderr}`;
    checks.push({
      name: 'nginx-vhost',
      ok: nginxDump.ok && dump.includes(`server_name ${options.domain}`) && dump.includes(`127.0.0.1:${options.appPort}`),
      detail: nginxDump.missing ? nginxDump.error : `site=${options.site} domain=${options.domain} upstream=127.0.0.1:${options.appPort}`
    });
  }

  const health = await requestUrl(urls.health, options.timeout);
  checks.push({
    name: 'public-health',
    ok: health.status === 200,
    detail: responseDetail(health)
  });
  const socket = await requestUrl(urls.socket, options.timeout);
  checks.push({
    name: 'public-socket',
    ok: [200, 400, 401, 403].includes(socket.status),
    detail: responseDetail(socket)
  });

  return { options, localIps: ips, checks };
}

function dnsDetail(addresses) {
  if (!Array.isArray(addresses)) return addresses.error;
  const cloudflare = addresses.some(isLikelyCloudflareIp) ? ' (Cloudflare/proxy DNS)' : '';
  return `${addresses.join(', ')}${cloudflare}`;
}

function isLikelyCloudflareIp(ip) {
  return /^104\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
    || /^172\.(6[4-9]|7[0-1])\./.test(ip)
    || /^162\.158\./.test(ip)
    || /^141\.101\./.test(ip)
    || /^108\.162\./.test(ip)
    || /^190\.93\./.test(ip)
    || /^188\.114\./.test(ip)
    || /^197\.234\./.test(ip)
    || /^198\.41\./.test(ip);
}

function responseDetail(response) {
  const location = response.location ? ` location=${response.location}` : '';
  const error = response.error ? ` ${response.error}` : '';
  return `status=${response.status}${location}${error}${wordpressHint(response.location)}`;
}

function wordpressHint(value) {
  return /wp-signup\.php/i.test(String(value || ''))
    ? ' (WordPress catch-all; check Cloudflare public hostname or DNS origin)'
    : '';
}

function printHuman(result) {
  for (const check of result.checks) {
    const mark = check.ok ? 'OK ' : 'FAIL';
    console.log(`${mark} ${check.name.padEnd(17)} ${check.detail || ''}`.trimEnd());
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }
  const result = await collect(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  return result.checks.every(check => check.ok) ? 0 : 1;
}

main()
  .then(code => {
    process.exitCode = Number(code || 0);
  })
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
