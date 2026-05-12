#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_HOSTNAME = '';
const DEFAULT_TUNNEL = 'dashboard-tunnel';
const DEFAULT_ORIGIN = 'http://127.0.0.1:3000';

function printUsage() {
  console.log(`Usage:
  node server/cloudflare-tunnel.js [options]

Options:
  --config server/cloudflare.config.json
  --hostname your-hostname.example.com
  --tunnel dashboard-tunnel
  --origin http://127.0.0.1:3000
  --quick                         Use a temporary trycloudflare.com URL
  --named                         Use a named Cloudflare Tunnel
  --no-health-check
  --dry-run

Examples:
  npm run cloudflare
  npm run cloudflare -- --config server/cloudflare.config.json
  npm run cloudflare -- --quick
  npm run cloudflare -- --named --hostname your-hostname.example.com --tunnel dashboard-tunnel
`);
}

function parseArgs(argv) {
  const provided = Object.create(null);
  const options = {
    config: '',
    hostname: DEFAULT_HOSTNAME,
    tunnel: DEFAULT_TUNNEL,
    origin: DEFAULT_ORIGIN,
    quick: true,
    named: false,
    noHealthCheck: false,
    dryRun: false,
    provided
  };

  const setValue = (key, value) => {
    options[key] = value;
    provided[key] = true;
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
    } else if (arg === '--config') {
      setValue('config', next());
    } else if (arg === '--hostname') {
      setValue('hostname', next());
    } else if (arg === '--tunnel') {
      setValue('tunnel', next());
    } else if (arg === '--origin' || arg === '--url') {
      setValue('origin', next());
    } else if (arg === '--quick') {
      setValue('quick', true);
      setValue('named', false);
    } else if (arg === '--named') {
      setValue('named', true);
      setValue('quick', false);
    } else if (arg === '--no-health-check') {
      setValue('noHealthCheck', true);
    } else if (arg === '--dry-run') {
      setValue('dryRun', true);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  new URL(options.origin);
  return options;
}

function loadJsonConfig(configPath) {
  if (!configPath) return null;
  const fullPath = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Config ${fullPath} must be a JSON object.`);
  }
  return config;
}

function applyConfig(options) {
  const config = loadJsonConfig(options.config);
  if (!config) return options;

  const aliases = {
    hostname: 'hostname',
    tunnel: 'tunnel',
    origin: 'origin',
    url: 'origin',
    quick: 'quick',
    named: 'named',
    noHealthCheck: 'noHealthCheck',
    no_health_check: 'noHealthCheck',
    dryRun: 'dryRun',
    dry_run: 'dryRun'
  };
  for (const [rawKey, value] of Object.entries(config)) {
    const key = aliases[rawKey];
    if (!key || options.provided[key]) continue;
    options[key] = value;
  }
  new URL(options.origin);
  return options;
}

function resolveCloudflared(skip) {
  const localBinary = process.platform === 'win32'
    ? path.join(__dirname, '..', '.toolchain', 'cloudflared', 'cloudflared.exe')
    : path.join(__dirname, '..', '.toolchain', 'cloudflared', 'cloudflared');

  if (fs.existsSync(localBinary)) {
    return localBinary;
  }

  if (skip) {
    return 'cloudflared';
  }

  const result = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('cloudflared is required but was not found in PATH or .toolchain/cloudflared.');
  }
  return 'cloudflared';
}

function healthUrl(origin) {
  const url = new URL(origin);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/health`;
  return url;
}

function requestHealth(url, timeout = 2500) {
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET',
      timeout,
      headers: { 'User-Agent': 'iot-cloudflare-tunnel/1.0' }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (_) {}
        resolve(res.statusCode === 200 && body?.status === 'healthy');
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeout}ms`)));
    req.on('error', () => resolve(false));
    req.end();
  });
}

function buildArgs(options) {
  if (!options.named) {
    return ['tunnel', '--url', options.origin];
  }
  if (!options.hostname) {
    throw new Error('--hostname is required when using --named.');
  }
  return ['tunnel', 'run', options.tunnel];
}

function printPlan(options, args, cloudflared = 'cloudflared') {
  const publicUrl = options.named ? `https://${options.hostname}` : 'the trycloudflare.com URL printed by cloudflared';
  console.log('');
  console.log('Cloudflare Tunnel plan:');
  console.log(`  Public URL: ${publicUrl}`);
  console.log(`  Local origin: ${options.origin}`);
  console.log(`  Mode: ${options.named ? `named tunnel '${options.tunnel}'` : 'quick temporary trycloudflare.com URL'}`);
  console.log('');
  if (options.named) {
    console.log('Use these dashboard env values before generating Android QR codes:');
    console.log(`ANDROID_BRIDGE_PUBLIC_URL=${publicUrl}`);
    console.log(`PUBLIC_BRIDGE_BASE_URL=${publicUrl}`);
    console.log(`SOCKET_IO_CORS_ORIGIN=${publicUrl}`);
  } else {
    console.log('After cloudflared starts, copy the printed https://*.trycloudflare.com URL into:');
    console.log('ANDROID_BRIDGE_PUBLIC_URL=<printed-url>');
    console.log('PUBLIC_BRIDGE_BASE_URL=<printed-url>');
    console.log('SOCKET_IO_CORS_ORIGIN=<printed-url-origin>');
  }
  console.log('');
  console.log(`${shellQuote(cloudflared)} ${args.map(shellQuote).join(' ')}`);
  console.log('');
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_/:=.,@+-]+$/.test(text) ? text : JSON.stringify(text);
}

async function main() {
  let options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }
  options = applyConfig(options);

  const cloudflared = resolveCloudflared(options.dryRun);
  if (!options.noHealthCheck && !options.dryRun) {
    const ok = await requestHealth(healthUrl(options.origin));
    if (!ok) {
      throw new Error(`Dashboard health is not reachable at ${healthUrl(options.origin)}. Start the dashboard first, or use --no-health-check.`);
    }
  }

  const args = buildArgs(options);
  printPlan(options, args, cloudflared);
  if (options.dryRun) return 0;

  const child = spawn(cloudflared, args, { stdio: 'inherit' });
  return new Promise((resolve) => {
    child.on('exit', code => resolve(code || 0));
    child.on('error', error => {
      console.error(`Failed to start cloudflared: ${error.message}`);
      resolve(1);
    });
  });
}

main()
  .then(code => {
    process.exitCode = Number(code || 0);
  })
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
