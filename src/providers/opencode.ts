/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  // Read from the .env file (like the claude provider) rather than only
  // ctx.hostEnv: under launchd/systemd the host process does NOT have .env
  // loaded into process.env, so ctx.hostEnv would miss these. File value wins,
  // with process.env as a fallback for dev (`pnpm run dev`) shells that export.
  //
  // OPENCODE_BASE_URL is the OpenCode provider `baseURL` (opencode.ts reads it,
  // preferring it over ANTHROPIC_BASE_URL) — kept distinct so it can't collide
  // with the Claude host provider, which reads ANTHROPIC_BASE_URL from .env.
  const keys = [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_BASE_URL',
    'ANTHROPIC_BASE_URL',
  ] as const;
  const dotenv = readEnvFile([...keys]);
  for (const key of keys) {
    const value = dotenv[key] || ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
