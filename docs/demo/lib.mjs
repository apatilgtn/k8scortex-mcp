// Shared helpers for the scripted demos: start a real K8sCortex HTTP server, connect users with
// signed test tokens, print tool calls and their real results, and collect the audit records.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 3123;
const SECRET = "demo-only-secret";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", blue: "\x1b[34m", reset: "\x1b[0m" };
export const out = (s = "") => process.stdout.write(s + "\n");
// Tool errors arrive as "MCP error -32603: <message>"; keep the message
export const plain = (t) => t.replace(/^MCP error -?\d+: /, "");

export async function type(text, delay = 28) {
  for (const ch of text) { process.stdout.write(ch); await sleep(delay); }
  out();
}

export const audit = [];
let server;

/** Starts K8sCortex over HTTP with the given extra environment and waits for /health. */
export async function startServer(env = {}) {
  server = spawn(process.execPath, [join(ROOT, "dist/index.js")], {
    env: { ...process.env, PORT: String(PORT), TEST_JWT_SECRET: SECRET, AUDIT_LOG_FILE: "/tmp/k8scortex-demo-audit.log", ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  createInterface({ input: server.stdout }).on("line", (line) => {
    try { const r = JSON.parse(line); if (r.event === "ToolInvocation") audit.push(r); } catch { /* startup text */ }
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch { /* starting */ }
    if (i === 300) { console.error("K8sCortex did not start within 60s"); process.exit(1); }
    await sleep(200);
  }
}

export function stopServer() { server?.kill(); }

/** Connects as a user whose token carries the given K8sCortex roles. */
export async function connect(user, roles) {
  const token = jwt.sign({ oid: user, roles }, SECRET, { expiresIn: "15m" });
  const client = new Client({ name: "demo", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

/** Calls a tool and prints the call plus the lines show() derives from its real result. */
export async function tool(client, name, args, show, { hide = ["namespace"] } = {}) {
  const shownArgs = Object.entries(args).filter(([k]) => !hide.includes(k)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  out(`  ${c.cyan}↳ ${name}${c.reset}${c.dim}(${shownArgs})${c.reset}`);
  await sleep(400);
  let text, ok;
  try {
    const res = await client.callTool({ name, arguments: args });
    ok = !res.isError; text = res.content?.[0]?.text ?? "";
  } catch (err) { ok = false; text = err.message; }
  for (const line of show(text, ok)) out(`      ${line}`);
  await sleep(900);
  return { text, ok };
}

/** Calls a tool without printing (for waiting on a rollout to settle). */
export async function quiet(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return res.content?.[0]?.text ?? "";
}

export async function ask(user, role, question) {
  out();
  process.stdout.write(`${c.bold}${user}${c.reset} ${c.dim}(${role})${c.reset} ${c.magenta}›${c.reset} `);
  await type(question);
  await sleep(300);
}

export async function waitForRollout(client, args) {
  for (let i = 0; i < 60; i++) {
    if (JSON.parse(await quiet(client, "rollout_status", args)).status === "complete") return;
    await sleep(1000);
  }
}
