#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL = process.env.PUBLIC_BASE_URL || process.env.ANDROID_BRIDGE_PUBLIC_URL || '';

function printUsage() {
  console.log(`Usage:
  node server/check-server.js --url https://your-tunnel.trycloudflare.com [options]

Options:
  --config server/tunnel.config.json
  --url https://your-tunnel.trycloudflare.com
  --timeout 5000
  --follow-redirects
  --max-redirects 5
  --allow-self-signed
  --json

Examples:
  npm run server:check -- --url https://your-tunnel.trycloudflare.com
  npm run server:check -- --config server/tunnel.config.json
  npm --prefix server run check -- --url http://127.0.0.1:3000/server
`);
}

function parseArgs(argv) {
  const provided = Object.create(null);
  const options = {
    config: '',
    url: DEFAULT_URL,
    timeout: 5000,
    followRedirects: false,
    maxRedirects: 5,
    allowSelfSigned: false,
    json: false,
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
    } else if (arg === '--url') {
      setValue('url', next());
    } else if (arg === '--timeout') {
      setValue('timeout', Number(next()));
    } else if (arg === '--follow-redirects') {
      setValue('followRedirects', true);
    } else if (arg === '--max-redirects') {
      setValue('maxRedirects', Number(next()));
    } else if (arg === '--allow-self-signed') {
      setValue('allowSelfSigned', true);
    } else if (arg === '--json') {
      setValue('json', true);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
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

  const url = config.url || config.baseUrl || config.base_url || config.publicUrl || config.public_url;
  if (url && !options.provided.url) {
    options.url = url;
  }
  if (config.timeout && !options.provided.timeout) {
    options.timeout = Number(config.timeout);
  }
  if ((config.followRedirects || config.follow_redirects) && !options.provided.followRedirects) {
    options.followRedirects = true;
  }
  if ((config.maxRedirects || config.max_redirects) && !options.provided.maxRedirects) {
    options.maxRedirects = Number(config.maxRedirects || config.max_redirects);
  }
  if ((config.allowSelfSigned || config.allow_self_signed) && !options.provided.allowSelfSigned) {
    options.allowSelfSigned = true;
  }
  return options;
}

function validateOptions(options) {
  if (!Number.isFinite(options.timeout) || options.timeout < 500) {
    throw new Error('--timeout must be at least 500 milliseconds.');
  }
  if (!Number.isInteger(options.maxRedirects) || options.maxRedirects < 0 || options.maxRedirects > 10) {
    throw new Error('--max-redirects must be an integer from 0 to 10.');
  }
  return options;
}

function normalizeBaseUrl(value) {
  if (!value) {
    throw new Error('--url is required unless PUBLIC_BASE_URL or ANDROID_BRIDGE_PUBLIC_URL is set.');
  }
  const parsed = new URL(value || DEFAULT_URL);
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed;
}

function endpoint(base, pathname) {
  const out = new URL(base.toString());
  const prefix = out.pathname.replace(/\/+$/, '');
  out.pathname = `${prefix}${pathname}`;
  return out;
}

function socketEndpoint(base) {
  const out = new URL(base.toString());
  out.pathname = '/socket.io/';
  out.searchParams.set('EIO', '4');
  out.searchParams.set('transport', 'polling');
  out.searchParams.set('t', Date.now().toString(36));
  return out;
}

function requestUrl(url, options, redirectChain = []) {
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET',
      timeout: options.timeout,
      rejectUnauthorized: !options.allowSelfSigned,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'iot-server-check/1.0'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const location = res.headers.location || '';
        const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && location;
        if (isRedirect && options.followRedirects) {
          if (redirectChain.length >= options.maxRedirects) {
            resolve({
              ok: false,
              status: res.statusCode || 0,
              headers: res.headers,
              body,
              error: `Too many redirects; last location ${location}${wordpressHint(location)}`,
              redirects: redirectChain
            });
            return;
          }
          const nextUrl = new URL(location, url);
          requestUrl(nextUrl, options, redirectChain.concat(`${url} -> ${nextUrl}`)).then(resolve);
          return;
        }
        resolve({
          ok: true,
          status: res.statusCode || 0,
          headers: res.headers,
          body,
          redirects: redirectChain
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out after ${options.timeout}ms`));
    });
    req.on('error', (error) => {
      resolve({ ok: false, status: 0, error: error.message, body: '', redirects: redirectChain });
    });
    req.end();
  });
}

function summarizeHealth(response) {
  let parsed = null;
  try {
    parsed = JSON.parse(response.body || '{}');
  } catch (_) {}
  const ok = response.ok && response.status === 200 && parsed?.status === 'healthy';
  return {
    name: 'health',
    ok,
    status: response.status,
    detail: parsed?.status || response.error || redirectDetail(response) || trimBody(response.body) || (ok ? 'healthy' : 'unexpected status'),
    redirects: response.redirects || []
  };
}

function summarizeSocket(response) {
  const reachableStatuses = new Set([200, 400, 401, 403]);
  const ok = response.ok && reachableStatuses.has(response.status);
  return {
    name: 'socket.io',
    ok,
    status: response.status,
    detail: response.error || redirectDetail(response) || trimBody(response.body) || (ok ? 'reachable' : 'unexpected status'),
    redirects: response.redirects || []
  };
}

function redirectDetail(response) {
  if (response.status >= 300 && response.status < 400 && response.headers?.location) {
    return `redirect to ${response.headers.location}${wordpressHint(response.headers.location)}`;
  }
  return '';
}

function wordpressHint(value) {
  return /wp-signup\.php/i.test(String(value || ''))
    ? ' (WordPress catch-all; Cloudflare public hostname is not routing to the dashboard tunnel)'
    : '';
}

function trimBody(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function printHuman(baseUrl, checks) {
  console.log(`Checking ${baseUrl}`);
  for (const check of checks) {
    const mark = check.ok ? 'OK ' : 'FAIL';
    console.log(`${mark} ${check.name.padEnd(9)} status=${check.status} ${check.detail || ''}`.trimEnd());
  }
}

async function main() {
  let options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return 0;
  }
  options = validateOptions(applyConfig(options));

  const base = normalizeBaseUrl(options.url);
  const healthUrl = endpoint(base, '/health');
  const socketUrl = socketEndpoint(base);
  const [health, socket] = await Promise.all([
    requestUrl(healthUrl, options),
    requestUrl(socketUrl, options)
  ]);
  const checks = [summarizeHealth(health), summarizeSocket(socket)];

  if (options.json) {
    console.log(JSON.stringify({ url: base.toString(), checks }, null, 2));
  } else {
    printHuman(base.toString(), checks);
  }

  return checks.every(check => check.ok) ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = Number(code || 0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
