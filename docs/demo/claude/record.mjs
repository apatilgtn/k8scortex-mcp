// Records real Claude Code sessions that use K8sCortex, for docs/demo/claude.gif.
//
// K8sCortex runs over HTTP with a staging and a prod cluster registered and prod policies applied. Each persona
// is a separate `claude -p` session whose only tool source is K8sCortex, signed in with that persona's
// token, so the server's roles and policies apply to Claude exactly as they would to that person.
// Output: session.json (prompts, Claude's tool calls, results and answers) and the server's audit records.
//
//   docs/demo/setup-clusters.sh && node docs/demo/claude/record.mjs     (needs `claude` logged in)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "../../..");
const PORT = 3124;
const SECRET = "demo-only-secret";
const STAGING = process.env.DEMO_STAGING_CONTEXT || "kind-k8scortex-staging";
const PROD = process.env.DEMO_PROD_CONTEXT || "kind-k8scortex-prod";
const WORK = mkdtempSync(join(tmpdir(), "k8scortex-claude-demo-"));

const PEOPLE = {
  priya: ["developer"],
  sam: ["release-manager"],
  maria: ["sre"],
  alex: ["platform-engineer"],
};

// Each step is one prompt. `continue` resumes that person's previous session in the same scene.
const SCENES = [
  { title: "Checkout is down in prod", why: "Every minute of a broken checkout is lost revenue. Diagnose fast, change safely.", steps: [
    { who: "priya", prompt: "Checkout in the shop namespace on the prod cluster is failing. What's wrong? If a bad rollout caused it, roll it back." },
    { who: "sam", prompt: "Roll back the checkout deployment in the shop namespace on prod. The 1.5.0 rollout is crash-looping." },
    { who: "maria", prompt: "Checkout in the shop namespace on the prod cluster is crash-looping after the 1.5.0 rollout. Show me what a rollback would do. Don't change anything yet." },
    { who: "maria", continue: true, prompt: "Looks right. Do it and confirm checkout is healthy." },
  ] },
  { title: "Is prod running what we tested?", why: "Releases that differ between staging and prod are how untested code reaches customers.", steps: [
    { who: "priya", prompt: "Is the payments Argo CD app (namespace argocd) on the same revision in staging and prod?" },
    { who: "sam", prompt: "Sync the payments Argo CD app (namespace argocd) in staging, then in prod." },
    { who: "sam", continue: true, prompt: "Staging looks fine. Yes, sync prod now." },
  ] },
  { title: "Flash sale in 10 minutes", why: "Scale ahead of traffic, but see the change before it happens.", steps: [
    { who: "maria", prompt: "Flash sale in 10 minutes. Scale checkout in the shop namespace on prod to 6 replicas: dry run first, then apply it and confirm all replicas are ready." },
  ] },
  { title: "Rotate the payments database password", why: "Credentials must not be readable by everyone, echoed back, or written to logs.", steps: [
    { who: "priya", prompt: "List the secrets in the shop namespace on prod." },
    { who: "maria", prompt: "Rotate the password key of the payments-db secret in the shop namespace on prod to a new strong random value. Don't show me the new value." },
    { who: "maria", continue: true, prompt: "Yes, apply it." },
  ] },
  { title: "Node maintenance", why: "Draining the wrong node during business hours causes an outage.", steps: [
    { who: "alex", prompt: "Drain the prod cluster's node for kernel patching." },
    { who: "alex", continue: true, prompt: "Yes, we're in the maintenance window. Drain it." },
    { who: "alex", continue: true, prompt: "OK, rehearse the drain on the staging node instead." },
  ] },
];

const SYSTEM = "You are helping an engineer operate Kubernetes through the k8scortex tools. Keep every reply to at most 4 short lines of plain text, no headings or tables. When a tool call is denied, say why in one line and stop.";
// No built-in tools (--tools ""), and the risky ones denied by name too: K8sCortex is Claude's only way to act
const BUILTINS = ["Bash", "PowerShell", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit", "TodoWrite"];

// ── K8sCortex server ─────────────────────────────────────────────────────────
const registry = join(WORK, "clusters.json");
writeFileSync(registry, JSON.stringify({
  defaultCluster: "staging",
  clusters: [
    { name: "staging", provider: "kubeconfig", context: STAGING, labels: { env: "staging" } },
    { name: "prod", provider: "kubeconfig", context: PROD, labels: { env: "prod" } },
  ],
  policies: [
    { labels: { env: "prod" }, minRole: "sre", appliesTo: "mutating" },
    { labels: { env: "prod" }, denyTools: ["drain_node", "delete_namespace"] },
  ],
}));

const audit = [];
const server = spawn(process.execPath, [join(ROOT, "dist/index.js")], {
  env: { ...process.env, PORT: String(PORT), TEST_JWT_SECRET: SECRET, CLUSTERS_CONFIG: registry, AUDIT_LOG_FILE: join(WORK, "audit.log") },
  stdio: ["ignore", "pipe", "inherit"],
});
let buffered = "";
server.stdout.on("data", (d) => {
  buffered += d;
  const lines = buffered.split("\n");
  buffered = lines.pop();
  for (const line of lines) { try { const r = JSON.parse(line); if (r.event === "ToolInvocation") audit.push(r); } catch { /* startup text */ } }
});
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch { /* starting */ }
  if (i === 150) throw new Error("K8sCortex did not start");
  await new Promise((r) => setTimeout(r, 200));
}

// ── Claude sessions ──────────────────────────────────────────────────────────
function mcpConfig(who) {
  const path = join(WORK, `mcp-${who}.json`);
  const token = jwt.sign({ oid: who, roles: PEOPLE[who] }, SECRET, { expiresIn: "2h" });
  writeFileSync(path, JSON.stringify({ mcpServers: { k8scortex: { type: "http", url: `http://localhost:${PORT}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));
  return path;
}

function runClaude(who, prompt, resume) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcpConfig(who), "--strict-mcp-config",
    "--tools", "", "--allowedTools", "mcp__k8scortex", "--disallowedTools", ...BUILTINS,
    "--append-system-prompt", SYSTEM, ...(resume ? ["--resume", resume] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: WORK, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const events = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (code !== 0 && !events.length) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      resolve(events);
    });
  });
}

// Keep what the replay shows: Claude's text, its tool calls and their results, in order
function simplify(events) {
  const items = [];
  for (const e of events) {
    for (const block of e.message?.content ?? []) {
      if (e.type === "assistant" && block.type === "text" && block.text.trim()) items.push({ kind: "text", text: block.text.trim() });
      if (e.type === "assistant" && block.type === "tool_use") items.push({ kind: "call", id: block.id, tool: block.name.replace(/^mcp__k8scortex__/, ""), input: maskSecrets(block.input) });
      if (e.type === "user" && block.type === "tool_result") {
        const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").join("\n") : String(block.content ?? "");
        items.push({ kind: "result", id: block.tool_use_id, error: !!block.is_error, text });
      }
    }
  }
  const result = events.find((e) => e.type === "result");
  return { items, model: events.find((e) => e.type === "system")?.model, costUsd: result?.total_cost_usd, sessionId: result?.session_id ?? events.find((e) => e.session_id)?.session_id };
}

// A rotated password is real in the throwaway cluster but has no business in a committed transcript
function maskSecrets(input) {
  if (!input?.stringData) return input;
  return { ...input, stringData: Object.fromEntries(Object.keys(input.stringData).map((k) => [k, "••••••••"])) };
}

const sessions = {};
const recorded = [];
for (const scene of SCENES) {
  const steps = [];
  for (const step of scene.steps) {
    process.stderr.write(`▶ ${step.who}: ${step.prompt}\n`);
    const resume = step.continue ? sessions[step.who] : undefined;
    const run = simplify(await runClaude(step.who, step.prompt, resume));
    sessions[step.who] = run.sessionId;
    for (const it of run.items) process.stderr.write(`   ${it.kind === "call" ? `→ ${it.tool} ${JSON.stringify(it.input)}` : it.kind === "result" ? `← ${it.error ? "ERROR " : ""}${it.text.replace(/\s+/g, " ").slice(0, 140)}` : `✎ ${it.text.replace(/\s+/g, " ")}`}\n`);
    steps.push({ who: step.who, roles: PEOPLE[step.who], prompt: step.prompt, model: run.model, items: run.items });
  }
  recorded.push({ title: scene.title, why: scene.why, steps });
}

server.kill();
const auditRows = audit.map((r) => ({ user: r.userOid, tool: r.tool, cluster: r.arguments?._cluster ?? null, dryRun: r.arguments?.dryRun, status: r.status, ...(r.tool === "update_secret" ? { stringData: r.arguments?.stringData } : {}) }));
writeFileSync(join(HERE, "session.json"), JSON.stringify({ recordedAt: new Date().toISOString(), system: SYSTEM, scenes: recorded, audit: auditRows }, null, 2) + "\n");
process.stderr.write(`\nsaved docs/demo/claude/session.json (${audit.length} audited calls)\n`);
process.exit(0);
