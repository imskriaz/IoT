#!/usr/bin/env node
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_FORWARD = '3000:3001';
const DEFAULT_PUBLIC_URL = '';
const FORWARD_PRESETS = {
  dashboard: DEFAULT_FORWARD,
  deployed: '3000:3000',
  chat: '3010:3010',
  live: '3011:3011',
  all: '3000:3001,3010:3010,3011:3011'
};

function printUsage() {
  console.log(`Usage:
  node server/share-tunnel.js --host YOUR_VPS_IP --user root [options]

Options:
  --config server/tunnel.config.json
  --preset dashboard|deployed|chat|live|all
  --forward 3000:3001,3010:3010  One or more remote:local mappings
  --public-url https://your-public-url.example.com
  --key /path/to/id_rsa
  --remote-bind 127.0.0.1
  --local-bind 127.0.0.1
  --skip-missing                  Keep running with only reachable local ports
  --no-health-check
  --reconnect
  --dry-run
  --list-presets

Examples:
  node server/share-tunnel.js --host YOUR_VPS_IP --user root --preset dashboard --reconnect
  node server/share-tunnel.js --host YOUR_VPS_IP --user root --preset all --skip-missing --reconnect
  node server/share-tunnel.js --config server/tunnel.config.json
`);
}

function parseArgs(argv) {
  const provided = Object.create(null);
  const out = {
    forward: DEFAULT_FORWARD,
    preset: '',
    config: '',
    remoteBind: '127.0.0.1',
    localBind: '127.0.0.1',
    publicUrl: DEFAULT_PUBLIC_URL,
    key: '',
    skipMissing: false,
    noHealthCheck: false,
    reconnect: false,
    dryRun: false,
    forwardProvided: false,
    provided
  };

  const setValue = (key, value) => {
    out[key] = value;
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
      out.help = true;
    } else if (arg === '--list-presets') {
      out.listPresets = true;
    } else if (arg === '--config') {
      setValue('config', next());
    } else if (arg === '--host' || arg === '--vps-host') {
      setValue('host', next());
    } else if (arg === '--user' || arg === '--vps-user') {
      setValue('user', next());
    } else if (arg === '--preset') {
      setValue('preset', next());
    } else if (arg === '--forward' || arg === '-f') {
      setValue('forward', next());
      out.forwardProvided = true;
    } else if (arg === '--public-url') {
      setValue('publicUrl', next());
    } else if (arg === '--key' || arg === '--ssh-key') {
      setValue('key', next());
    } else if (arg === '--remote-bind') {
      setValue('remoteBind', next());
    } else if (arg === '--local-bind') {
      setValue('localBind', next());
    } else if (arg === '--skip-missing') {
      setValue('skipMissing', true);
    } else if (arg === '--no-health-check') {
      setValue('noHealthCheck', true);
    } else if (arg === '--reconnect') {
      setValue('reconnect', true);
    } else if (arg === '--dry-run') {
      setValue('dryRun', true);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return out;
}

function loadJsonConfig(configPath) {
  if (!configPath) return null;
  const fullPath = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Config ${fullPath} must be a JSON object.`);
  }
  return { config, fullPath };
}

function applyConfig(options) {
  const loaded = loadJsonConfig(options.config);
  if (!loaded) return options;

  const aliases = {
    public_url: 'publicUrl',
    publicUrl: 'publicUrl',
    remote_bind: 'remoteBind',
    remoteBind: 'remoteBind',
    local_bind: 'localBind',
    localBind: 'localBind',
    skip_missing: 'skipMissing',
    skipMissing: 'skipMissing',
    no_health_check: 'noHealthCheck',
    noHealthCheck: 'noHealthCheck',
    dry_run: 'dryRun',
    dryRun: 'dryRun',
    ssh_key: 'key',
    key: 'key',
    host: 'host',
    user: 'user',
    preset: 'preset',
    forward: 'forward',
    reconnect: 'reconnect'
  };

  for (const [rawKey, value] of Object.entries(loaded.config)) {
    const key = aliases[rawKey];
    if (!key || options.provided[key]) continue;
    options[key] = Array.isArray(value) ? value.join(',') : value;
    if (key === 'forward') {
      options.forwardProvided = true;
    }
  }

  options.configPath = loaded.fullPath;
  return options;
}

function resolveForwardSpec(options) {
  if (options.preset) {
    if (!Object.prototype.hasOwnProperty.call(FORWARD_PRESETS, options.preset)) {
      throw new Error(`Unknown preset '${options.preset}'. Use --list-presets to see available presets.`);
    }
    if (!options.forwardProvided) {
      return FORWARD_PRESETS[options.preset];
    }
  }
  return options.forward;
}

function printPresets() {
  console.log('Available tunnel presets:');
  for (const [name, forward] of Object.entries(FORWARD_PRESETS)) {
    console.log(`  ${name.padEnd(10)} ${forward}`);
  }
}

function parseForward(spec, localBind) {
  const parts = String(spec || '').trim().split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid forward '${spec}'. Use remotePort:localPort or remotePort:localPort:localHost.`);
  }

  const remotePort = Number(parts[0]);
  const localPort = Number(parts[1]);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error(`Invalid remote port in '${spec}'.`);
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error(`Invalid local port in '${spec}'.`);
  }

  return {
    remotePort,
    localPort,
    localHost: parts[2] || localBind
  };
}

function splitForwardList(value) {
  return String(value || DEFAULT_FORWARD)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function ensureSsh() {
  const result = spawnSync('ssh', ['-V'], { stdio: 'ignore' });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('ssh is required but was not found in PATH.');
  }
}

function checkLocalPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);

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

async function validateLocalTargets(rules, options) {
  if (options.noHealthCheck || options.dryRun) return rules;
  const reachable = [];
  for (const rule of rules) {
    const ok = await checkLocalPort(rule.localHost, rule.localPort);
    if (!ok) {
      if (options.skipMissing) {
        console.warn(`Skipping ${rule.localHost}:${rule.localPort}; local service is not reachable.`);
        continue;
      }
      throw new Error(`Local target ${rule.localHost}:${rule.localPort} is not reachable. Start it first, or use --no-health-check.`);
    }
    reachable.push(rule);
  }
  if (!reachable.length) {
    throw new Error('No reachable local targets found.');
  }
  return reachable;
}

function buildSshArgs(options, rules) {
  const args = [
    '-N',
    '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'Compression=no',
    '-o', 'AddressFamily=inet',
    '-o', 'ConnectTimeout=10',
    '-o', 'IPQoS=lowdelay'
  ];

  if (options.key) {
    args.unshift('-i', options.key);
  }

  for (const rule of rules) {
    args.push('-R', `${options.remoteBind}:${rule.remotePort}:${rule.localHost}:${rule.localPort}`);
  }
  args.push(`${options.user}@${options.host}`);
  return args;
}

function printPlan(options, rules, sshArgs) {
  if (options.publicUrl) {
    const socketOrigin = publicOrigin(options.publicUrl);
    console.log('');
    console.log('Keep these in dashboard/.env before generating Android QR codes:');
    console.log(`ANDROID_BRIDGE_PUBLIC_URL=${options.publicUrl}`);
    console.log(`SOCKET_IO_CORS_ORIGIN=${socketOrigin}`);
    console.log('');
  }

  console.log('Opening fast reverse tunnel:');
  for (const rule of rules) {
    console.log(`  VPS ${options.remoteBind}:${rule.remotePort} -> local ${rule.localHost}:${rule.localPort}`);
  }
  console.log('Use one tunnel for dashboard, chat, live updates, Socket.IO, SSE, or any local HTTP/TCP service.');
  console.log('Keep this process running.');
  console.log('');

  if (options.dryRun) {
    console.log('Dry run SSH command:');
    console.log(`ssh ${sshArgs.map(shellQuote).join(' ')}`);
  }
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_/:=.,@+-]+$/.test(text) ? text : JSON.stringify(text);
}

function publicOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (_) {
    return String(value || '').replace(/\/+$/, '');
  }
}

function runSsh(sshArgs, reconnect) {
  return new Promise((resolve) => {
    const start = () => {
      const child = spawn('ssh', sshArgs, { stdio: 'inherit' });
      child.on('exit', (code) => {
        if (!reconnect) {
          resolve(code || 0);
          return;
        }
        console.log(`Tunnel exited with code ${code}. Reconnecting in 3 seconds...`);
        setTimeout(start, 3000);
      });
      child.on('error', (error) => {
        console.error(`Failed to start ssh: ${error.message}`);
        if (!reconnect) {
          resolve(1);
          return;
        }
        setTimeout(start, 3000);
      });
    };
    start();
  });
}

async function main() {
  let options = parseArgs(process.argv.slice(2));
  if (options.listPresets) {
    printPresets();
    return 0;
  }
  if (options.help) {
    printUsage();
    return 0;
  }
  options = applyConfig(options);
  if (!options.host || !options.user) {
    printUsage();
    throw new Error('--host and --user are required.');
  }

  ensureSsh();
  const forwardSpec = resolveForwardSpec(options);
  let rules = splitForwardList(forwardSpec).map(spec => parseForward(spec, options.localBind));
  rules = await validateLocalTargets(rules, options);
  const sshArgs = buildSshArgs(options, rules);
  printPlan(options, rules, sshArgs);
  if (options.dryRun) return 0;
  return runSsh(sshArgs, options.reconnect);
}

main()
  .then((code) => {
    process.exitCode = Number(code || 0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
