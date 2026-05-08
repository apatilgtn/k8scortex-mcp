/**
 * C-07 + C-08: Auth-enabled integration test and audit log assertions.
 *
 * Starts the MCP HTTP server with DISABLE_AUTH=false and TEST_JWT_SECRET set.
 * Exercises four security scenarios:
 *
 *   1. No token            → HTTP 401 from auth middleware
 *   2. Invalid/bad token   → HTTP 403 from auth middleware
 *   3. Expired token       → HTTP 403 from auth middleware
 *   4. Valid token, wrong role → MCP error "Unauthorized to invoke tool" + audit:denied
 *   5. Valid token, right role → auth passes, audit:success or audit:failure (never denied)
 *
 * Closes C-07 (auth enforcement) and C-08 (audit log assertions).
 * Does NOT require a live Kubernetes cluster.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpError } from '@modelcontextprotocol/sdk/types.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const TEST_SECRET = 'kubenexus-test-secret-do-not-use-in-production';
const TEST_PORT   = 3099;
const BASE_URL    = `http://localhost:${TEST_PORT}`;
const MCP_URL     = `${BASE_URL}/mcp`;
const AUDIT_FILE  = join(process.cwd(), `audit-test-${TEST_PORT}.log`);

// ── JWT helpers ───────────────────────────────────────────────────────────────

function signToken(payload: object, expiresIn = '5m'): string {
  return jwt.sign(payload, TEST_SECRET, { expiresIn } as jwt.SignOptions);
}

const developerToken = signToken({ oid: 'test-developer', roles: ['developer'] });
const adminToken     = signToken({ oid: 'test-admin',     roles: ['platform-engineer'] });
const expiredToken   = signToken({ oid: 'test-expired',   roles: ['platform-engineer'] }, '-1s');
const badToken       = 'this.is.not.a.jwt';

// ── Server lifecycle ──────────────────────────────────────────────────────────

let serverProcess: ChildProcess;

async function waitForServer(timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server at ${BASE_URL} did not become healthy within ${timeoutMs}ms`);
}

beforeAll(async () => {
  if (existsSync(AUDIT_FILE)) unlinkSync(AUDIT_FILE);

  serverProcess = spawn('node', ['dist/index.js'], {
    env: {
      ...process.env,
      PORT:               String(TEST_PORT),
      DISABLE_AUTH:       'false',
      TEST_JWT_SECRET:    TEST_SECRET,
      AUDIT_LOG_FILE:     AUDIT_FILE,
      // Use local kubeconfig so tool handlers can reach the cluster without Key Vault
      USE_LOCAL_KUBECONFIG: 'true',
    },
    stdio: 'pipe',
  });

  serverProcess.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

  await waitForServer();
}, 20_000);

afterAll(() => {
  serverProcess?.kill('SIGTERM');
  if (existsSync(AUDIT_FILE)) unlinkSync(AUDIT_FILE);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Probe the SSE endpoint with a raw fetch — returns HTTP status before MCP framing. */
async function probeGet(token?: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  // Use a short AbortController timeout so the SSE stream doesn't hang the test
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 1000);
  try {
    const res = await fetch(MCP_URL, { headers, signal: ac.signal });
    return res.status;
  } catch {
    // Aborted after a 200 SSE stream started — connection was accepted
    return 200;
  } finally {
    clearTimeout(tid);
  }
}

/** Create an MCP SDK client with a bearer token injected via requestInit. */
async function mcpClient(token: string): Promise<Client> {
  const transport = new SSEClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'auth-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function readAuditLog(): Array<Record<string, unknown>> {
  if (!existsSync(AUDIT_FILE)) return [];
  return readFileSync(AUDIT_FILE, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function lastAuditEntry(tool: string, userOid?: string): Record<string, unknown> | undefined {
  return readAuditLog()
    .filter(e => e['tool'] === tool && (!userOid || e['userOid'] === userOid))
    .at(-1);
}

// ── C-07: Auth middleware (HTTP level) ────────────────────────────────────────

describe('C-07: Authentication enforcement at HTTP layer', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const status = await probeGet(undefined);
    expect(status).toBe(401);
  });

  it('returns 403 for a completely invalid token', async () => {
    const status = await probeGet(badToken);
    expect(status).toBe(403);
  });

  it('returns 403 for an expired token', async () => {
    const status = await probeGet(expiredToken);
    expect(status).toBe(403);
  });

  it('accepts a valid token and establishes the SSE connection (HTTP 200)', async () => {
    const status = await probeGet(developerToken);
    expect(status).toBe(200);
  });
});

// ── C-07: Role enforcement (MCP protocol level) ───────────────────────────────

describe('C-07: Role-based authorisation via MCP protocol', () => {
  it('denies developer token calling delete_namespace (requires platform-engineer)', async () => {
    const client = await mcpClient(developerToken);
    let caughtMessage = '';
    try {
      await client.callTool({ name: 'delete_namespace', arguments: { namespaceName: 'kx-test-role-check' } });
    } catch (e: unknown) {
      caughtMessage = (e as McpError).message ?? (e as Error).message ?? String(e);
    }
    // Server throws for role denial — SDK surfaces it as McpError or isError result
    expect(caughtMessage).toMatch(/[Uu]nauthorized to invoke/);
    await client.close();
  });

  it('allows platform-engineer token to pass auth for delete_namespace (K8s may error)', async () => {
    const client = await mcpClient(adminToken);
    let caughtMessage = '';
    try {
      await client.callTool({ name: 'delete_namespace', arguments: { namespaceName: 'kx-definitely-does-not-exist-authtest' } });
    } catch (e: unknown) {
      caughtMessage = (e as McpError).message ?? (e as Error).message ?? String(e);
    }
    // Auth must have passed — any error must be from Kubernetes, not role enforcement
    expect(caughtMessage).not.toMatch(/[Uu]nauthorized to invoke/);
    await client.close();
  });
});

// ── C-08: Audit log assertions ────────────────────────────────────────────────

describe('C-08: Audit log content assertions', () => {
  it('writes a denied entry when developer attempts delete_namespace', async () => {
    const entry = lastAuditEntry('delete_namespace', 'test-developer');
    expect(entry).toBeDefined();
    expect(entry!['status']).toBe('denied');
    expect(entry!['event']).toBe('ToolInvocation');
  });

  it('denied audit entry carries errorMessage', async () => {
    const entry = lastAuditEntry('delete_namespace', 'test-developer');
    expect(entry).toBeDefined();
    expect(typeof entry!['errorMessage']).toBe('string');
    // The exact message is set in roles.ts / index.ts — verify it is non-empty
    expect((entry!['errorMessage'] as string).length).toBeGreaterThan(0);
  });

  it('denied audit entry records the correct userOid', async () => {
    const entry = lastAuditEntry('delete_namespace', 'test-developer');
    expect(entry!['userOid']).toBe('test-developer');
  });

  it('authorized call is logged as success or failure — never denied', async () => {
    // Make a call that passes auth (list_pods, developer role is sufficient)
    const client = await mcpClient(developerToken);
    try {
      await client.callTool({ name: 'list_pods', arguments: { namespace: 'default' } });
    } catch { /* K8s error is acceptable — we only care about the audit status */ }
    await client.close();

    const entry = lastAuditEntry('list_pods', 'test-developer');
    expect(entry).toBeDefined();
    expect(entry!['status']).not.toBe('denied');
    expect(entry!['userOid']).toBe('test-developer');
  });

  it('every audit record has timestamp, event, tool, and arguments fields', async () => {
    const entries = readAuditLog();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e['timestamp']).toBe('string');
      expect(e['event']).toBe('ToolInvocation');
      expect(typeof e['tool']).toBe('string');
      expect(e).toHaveProperty('arguments');
    }
  });
});
