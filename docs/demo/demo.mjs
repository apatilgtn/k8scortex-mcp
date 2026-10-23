// Scripted K8sCortex session for the README demo (docs/demo/README.md).
// Every result shown is a real MCP tool call against the current kube context; nothing is mocked
// and no LLM is involved. Two users connect over Streamable HTTP with signed test tokens.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NS = process.env.DEMO_NAMESPACE || "shop";
const PORT = 3123;
const SECRET = "demo-only-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", reset: "\x1b[0m" };
const out = (s = "") => process.stdout.write(s + "\n");

async function type(text, delay = 28) {
  for (const ch of text) { process.stdout.write(ch); await sleep(delay); }
  out();
}

// ── Server: real K8sCortex over HTTP, audit records collected from its stdout ──
const audit = [];
const server = spawn(process.execPath, [join(ROOT, "dist/index.js")], {
  env: { ...process.env, PORT: String(PORT), TEST_JWT_SECRET: SECRET, AUDIT_LOG_FILE: "/tmp/k8scortex-demo-audit.log" },
  stdio: ["ignore", "pipe", "ignore"],
});
createInterface({ input: server.stdout }).on("line", (line) => {
  try { const r = JSON.parse(line); if (r.event === "ToolInvocation") audit.push(r); } catch { /* startup text */ }
});
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch { /* starting */ }
  if (i === 300) { console.error("K8sCortex did not start within 60s"); process.exit(1); }
  await sleep(200);
}

async function connect(user, roles) {
  const token = jwt.sign({ oid: user, roles }, SECRET, { expiresIn: "10m" });
  const client = new Client({ name: "demo", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function tool(client, name, args, show) {
  const shownArgs = Object.entries(args).filter(([k]) => k !== "namespace").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  out(`  ${c.cyan}↳ ${name}${c.reset}${c.dim}(${shownArgs})${c.reset}`);
  await sleep(400);
  let text, ok;
  try {
    const res = await client.callTool({ name, arguments: args });
    ok = !res.isError; text = res.content?.[0]?.text ?? "";
  } catch (err) { ok = false; text = err.message; }
  for (const line of show(text, ok)) out(`      ${line}`);
  await sleep(900);
  return text;
}

async function ask(user, role, question) {
  out();
  process.stdout.write(`${c.bold}${user}${c.reset} ${c.dim}(${role})${c.reset} ${c.magenta}›${c.reset} `);
  await type(question);
  await sleep(300);
}

// ── The session ──────────────────────────────────────────────────────────────
out(`${c.bold}K8sCortex${c.reset} ${c.dim}· real MCP calls against a kind cluster · no LLM in this recording${c.reset}`);
const priya = await connect("priya", ["developer"]);
const sam = await connect("sam", ["release-manager"]);

await ask("priya", "developer", `why is checkout crashing in ${NS}?`);
let crashing;
await tool(priya, "list_pods", { namespace: NS }, (t) => JSON.parse(t).map((p) => {
  if (p.reason && !crashing) crashing = p.name;
  const state = p.reason ? `${c.red}${p.reason}${c.reset}` : `${c.green}${p.status}${c.reset}`;
  return `${p.name.padEnd(28)} ${state}  ${c.dim}restarts ${p.restartCount}${c.reset}`;
}));
await tool(priya, "get_pod_logs", { namespace: NS, podName: crashing, tailLines: 2 }, (t) =>
  t.trim().split("\n").map((l) => (l.startsWith("ERROR") ? `${c.red}${l}${c.reset}` : l)));

await ask("priya", "developer", "roll it back");
await tool(priya, "rollout_undo", { namespace: NS, deploymentName: "checkout", dryRun: false }, (t) =>
  [`${c.yellow}✗ ${t.replace(/^MCP error -?\d+: /, "").split(". ")[0]}${c.reset} ${c.dim}— needs release-manager${c.reset}`]);

await ask("sam", "release-manager", "roll checkout back to the last good version");
await tool(sam, "rollout_undo", { namespace: NS, deploymentName: "checkout" }, (t) =>
  [`${c.yellow}${t.replace(/ on cluster '[^']*'/, "")}${c.reset}`]);
await ask("sam", "release-manager", "looks right, do it");
await tool(sam, "rollout_undo", { namespace: NS, deploymentName: "checkout", dryRun: false }, (t, ok) =>
  [ok ? `${c.green}✓ ${t.replace(/ on cluster '[^']*'/, "")}${c.reset}` : `${c.red}${t}${c.reset}`]);
for (let i = 0; i < 30; i++) {
  const s = JSON.parse((await sam.callTool({ name: "rollout_status", arguments: { namespace: NS, deploymentName: "checkout" } })).content[0].text);
  if (s.status === "complete") break;
  await sleep(1000);
}
await tool(sam, "rollout_status", { namespace: NS, deploymentName: "checkout" }, (t) => {
  const s = JSON.parse(t);
  return [`${c.green}${s.status}${c.reset} · ${s.replicas.available}/${s.replicas.desired} available`];
});

out();
out(`${c.bold}audit log${c.reset} ${c.dim}(stdout of the server, one JSON record per call)${c.reset}`);
// Write tools default to a dry run unless the call passed dryRun: false
const label = (r) => (r.tool === "rollout_undo" && r.arguments?.dryRun !== false ? "rollout_undo (dry run)" : r.tool);
// Consecutive identical records (rollout_status polling while the rollback settles) are shown once
const rows = audit.filter((r, i) => i === 0 || r.userOid !== audit[i - 1].userOid || label(r) !== label(audit[i - 1]) || r.status !== audit[i - 1].status);
for (const r of rows) {
  const colour = r.status === "denied" ? c.yellow : r.status === "success" ? c.green : c.red;
  out(`  ${r.userOid.padEnd(6)} ${label(r).padEnd(23)} ${colour}${r.status}${c.reset}`);
}
await sleep(3500);

await priya.close();
await sam.close();
server.kill();
process.exit(0);
