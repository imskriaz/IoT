#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const dashboardDir = path.join(repoRoot, 'dashboard');
const dashboardPort = Number.parseInt(process.env.PORT || '3001', 10);
const dashboardHealthUrl = `http://127.0.0.1:${dashboardPort}/health`;
const startupTimeoutMs = Number.parseInt(process.env.STARTUP_TIMEOUT_MS || '30000', 10);

let dashboard;
let tunnel;
let shuttingDown = false;

function startNode(label, script, cwd) {
  console.log(`[start] Launching ${label}...`);
  const child = spawn(process.execPath, [script], {
    cwd,
    env: process.env,
    stdio: 'inherit'
  });

  child.on('error', (error) => {
    console.error(`[start] Could not launch ${label}: ${error.message}`);
  });

  return child;
}

function healthCheck() {
  return new Promise((resolve) => {
    const request = http.get(dashboardHealthUrl, { timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForDashboard() {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (dashboard.exitCode !== null) {
      throw new Error(`Dashboard exited during startup with code ${dashboard.exitCode}.`);
    }
    if (await healthCheck()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Dashboard was not healthy at ${dashboardHealthUrl} within ${startupTimeoutMs}ms.`);
}

function stopChild(child) {
  if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(tunnel);
  stopChild(dashboard);
  process.exitCode = code;

  const forceExit = setTimeout(() => process.exit(code), 6000);
  forceExit.unref();
}

async function main() {
  dashboard = startNode('dashboard', 'server.js', dashboardDir);
  dashboard.once('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[start] Dashboard stopped (${signal || `code ${code}`}); stopping all services.`);
    shutdown(code || 1);
  });

  await waitForDashboard();
  console.log(`[start] Dashboard is healthy at ${dashboardHealthUrl}.`);

  tunnel = startNode('Cloudflare tunnel', path.join(__dirname, 'cloudflare-tunnel.js'), repoRoot);
  tunnel.once('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[start] Cloudflare tunnel stopped (${signal || `code ${code}`}); stopping all services.`);
    shutdown(code || 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  console.error(`[start] ${error.message}`);
  shutdown(1);
});
