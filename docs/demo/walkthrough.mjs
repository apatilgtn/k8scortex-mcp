// Five business scenarios against two real clusters (staging and prod), for docs/demo/walkthrough.gif.
// Every result is a real MCP tool call; there is no LLM in the recording. See docs/demo/README.md.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c, out, sleep, plain, audit, startServer, stopServer, connect, tool, ask, waitForRollout } from "./lib.mjs";
import { TOOL_ROLE_REQUIREMENTS } from "../../dist/roles.js";

const STAGING = process.env.DEMO_STAGING_CONTEXT || "kind-k8scortex-staging";
const PROD = process.env.DEMO_PROD_CONTEXT || "kind-k8scortex-prod";
const shop = { namespace: "shop" };

// The registry and policies a platform team would ship: prod needs sre for any change and never drains nodes
const registry = join(tmpdir(), "k8scortex-walkthrough-clusters.json");
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

async function scene(n, title, why) {
  out();
  out(`${c.blue}${c.bold}━━ ${n}/5  ${title} ${"━".repeat(Math.max(0, 70 - title.length))}${c.reset}`);
  out(`${c.dim}   ${why}${c.reset}`);
  await sleep(1800);
}

// A role-table denial names only the tool, so add the role it needs (from the server's own table)
const denied = (t) => {
  const msg = plain(t);
  const roleDenied = msg.match(/^Unauthorized to invoke tool: (\w+)\.?$/);
  const text = roleDenied ? `${roleDenied[1]} needs role ${TOOL_ROLE_REQUIREMENTS[roleDenied[1]]} or higher` : msg.replace(/^Unauthorized to invoke tool: \w+\. ?/, "");
  return [`${c.yellow}✗ ${text}${c.reset}`];
};
const done = (t, ok) => [ok ? `${c.green}✓ ${t.replace(/ on cluster '[^']*'/, "").replace(/\.$/, "")}${c.reset}` : `${c.red}${plain(t)}${c.reset}`];
const dry = (t) => [`${c.yellow}${t.replace(/ on cluster '[^']*'/, "")}${c.reset}`];

await startServer({ CLUSTERS_CONFIG: registry });
out(`${c.bold}K8sCortex walkthrough${c.reset} ${c.dim}· two kind clusters (staging, prod) · real MCP calls · no LLM in this recording${c.reset}`);
out(`${c.dim}policy: prod requires sre for any change · drain_node and delete_namespace are disabled on prod${c.reset}`);
const priya = await connect("priya", ["developer"]);
const sam = await connect("sam", ["release-manager"]);
const maria = await connect("maria", ["sre"]);
const alex = await connect("alex", ["platform-engineer"]);

// ── 1. Incident ──────────────────────────────────────────────────────────────
await scene(1, "Checkout is down in prod", "Every minute of a broken checkout is lost revenue. Diagnose fast, change safely.");
await ask("priya", "developer", "checkout is failing in prod, what's wrong?");
let crashing;
await tool(priya, "list_pods", { ...shop, cluster: "prod" }, (t) => JSON.parse(t).filter((p) => p.reason !== "Terminating").map((p) => {
  if (p.reason && !crashing) crashing = p.name;
  const state = p.reason ? `${c.red}${p.reason}${c.reset}` : `${c.green}${p.status}${c.reset}`;
  return `${p.name.padEnd(28)} ${state}  ${c.dim}restarts ${p.restartCount}${c.reset}`;
}));
await tool(priya, "get_pod_logs", { ...shop, podName: crashing, tailLines: 2, cluster: "prod" }, (t) =>
  t.trim().split("\n").map((l) => (l.startsWith("ERROR") ? `${c.red}${l}${c.reset}` : l)));
await ask("priya", "developer", "roll it back");
await tool(priya, "rollout_undo", { ...shop, deploymentName: "checkout", dryRun: false, cluster: "prod" }, denied);
await ask("sam", "release-manager", "roll back checkout in prod");
await tool(sam, "rollout_undo", { ...shop, deploymentName: "checkout", dryRun: false, cluster: "prod" }, denied);
await ask("maria", "sre", "show me what a rollback of checkout in prod would do");
await tool(maria, "rollout_undo", { ...shop, deploymentName: "checkout", cluster: "prod" }, dry);
await ask("maria", "sre", "go ahead");
await tool(maria, "rollout_undo", { ...shop, deploymentName: "checkout", dryRun: false, cluster: "prod" }, done);
await waitForRollout(maria, { ...shop, deploymentName: "checkout", cluster: "prod" });
await tool(maria, "rollout_status", { ...shop, deploymentName: "checkout", cluster: "prod" }, (t) => {
  const s = JSON.parse(t);
  return [`${c.green}${s.status}${c.reset} · ${s.replicas.available}/${s.replicas.desired} available · checkout restored`];
});

// ── 2. Release drift ─────────────────────────────────────────────────────────
await scene(2, "Is prod running what we tested?", "Releases that differ between staging and prod are how untested code reaches customers.");
await ask("priya", "developer", "is payments the same in staging and prod?");
await tool(priya, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "payments", clusterA: "staging", clusterB: "prod" }, (t) => {
  const r = JSON.parse(t);
  return [
    `staging  ${r.staging.revision}  ${c.dim}${r.staging.syncStatus}${c.reset}`,
    `prod     ${r.prod.revision}  ${c.yellow}${r.prod.syncStatus}${c.reset}`,
    r.driftDetected ? `${c.yellow}drift detected: prod is not on the revision staging tested${c.reset}` : `${c.green}no drift${c.reset}`,
  ];
}, { hide: [] });
await ask("sam", "release-manager", "re-sync payments in staging before we promote it");
await tool(sam, "sync_gitops_app", { engine: "argocd", namespace: "argocd", appName: "payments", dryRun: false, cluster: "staging" }, done, { hide: [] });
await ask("sam", "release-manager", "and sync prod too");
await tool(sam, "sync_gitops_app", { engine: "argocd", namespace: "argocd", appName: "payments", dryRun: false, cluster: "prod" }, denied, { hide: [] });

// ── 3. Peak traffic ──────────────────────────────────────────────────────────
await scene(3, "Flash sale in 10 minutes", "Scale ahead of traffic, but see the change before it happens.");
await ask("maria", "sre", "scale checkout in prod to 6 replicas");
await tool(maria, "scale_deployment", { ...shop, deploymentName: "checkout", replicas: 6, cluster: "prod" }, dry);
await ask("maria", "sre", "confirmed, scale it");
await tool(maria, "scale_deployment", { ...shop, deploymentName: "checkout", replicas: 6, dryRun: false, cluster: "prod" }, done);
await waitForRollout(maria, { ...shop, deploymentName: "checkout", cluster: "prod" });
await tool(maria, "rollout_status", { ...shop, deploymentName: "checkout", cluster: "prod" }, (t) => {
  const s = JSON.parse(t);
  return [`${c.green}${s.status}${c.reset} · ${s.replicas.available}/${s.replicas.desired} available`];
});

// ── 4. Secrets ───────────────────────────────────────────────────────────────
await scene(4, "Rotate the payments database password", "Credentials must not be readable by everyone, echoed back, or written to logs.");
await ask("priya", "developer", "list the secrets in prod's shop namespace");
await tool(priya, "list_k8s_resources", { version: "v1", resource: "secrets", ...shop, cluster: "prod" }, denied, { hide: [] });
await ask("maria", "sre", "rotate the payments-db password in prod");
// The new value is sent in the call but kept off the screen here; the server never returns or logs it
await tool(maria, "update_secret", { ...shop, secretName: "payments-db", stringData: { password: "n3w-Rotated-Pa55" }, dryRun: false, cluster: "prod" },
  (t, ok) => [...done(t, ok), `${c.dim}the new value is not echoed back, and the audit record below has it redacted${c.reset}`],
  { hide: ["namespace", "stringData"] });

// ── 5. Node maintenance ──────────────────────────────────────────────────────
await scene(5, "Node maintenance", "Draining the wrong node during business hours causes an outage. Prod is protected by policy.");
await ask("alex", "platform-engineer", "drain the prod node for kernel patching");
await tool(alex, "drain_node", { nodeName: "k8scortex-prod-control-plane", cluster: "prod" }, denied, { hide: [] });
await ask("alex", "platform-engineer", "ok, rehearse it on staging");
await tool(alex, "drain_node", { nodeName: "k8scortex-staging-control-plane", cluster: "staging" }, dry, { hide: [] });

// ── Audit ────────────────────────────────────────────────────────────────────
await sleep(600);
out();
out(`${c.blue}${c.bold}━━ Audit trail ${"━".repeat(64)}${c.reset}`);
out(`${c.dim}   one JSON record per call on the server's stdout, ready for your SIEM${c.reset}`);
// Write tools default to a dry run; only label calls that actually ran as one
const isDry = (r) => r.status === "success" && ["rollout_undo", "scale_deployment", "drain_node", "update_secret", "sync_gitops_app"].includes(r.tool) && r.arguments?.dryRun !== false;
const rows = audit.filter((r) => r.tool !== "rollout_status" || r.status !== "success" || r === audit.findLast((x) => x.tool === "rollout_status"));
const seen = new Set();
for (const r of rows) {
  const key = `${r.userOid}|${r.tool}|${r.arguments?._cluster}|${r.status}|${isDry(r)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const colour = r.status === "denied" ? c.yellow : r.status === "success" ? c.green : c.red;
  // Calls stopped by the role table never reach a cluster
  const where = r.arguments?._cluster ?? r.arguments?.cluster ?? "—";
  out(`  ${r.userOid.padEnd(6)} ${(r.tool + (isDry(r) ? " (dry run)" : "")).padEnd(28)} ${String(where).padEnd(13)} ${colour}${r.status}${c.reset}`);
}
const rotation = audit.find((r) => r.tool === "update_secret");
if (rotation) {
  out();
  out(`  ${c.dim}${JSON.stringify({ user: rotation.userOid, tool: rotation.tool, secretName: rotation.arguments.secretName, stringData: rotation.arguments.stringData, status: rotation.status })}${c.reset}`);
}
out();
out(`${c.dim}end of walkthrough${c.reset}`);
await sleep(5000);

for (const client of [priya, sam, maria, alex]) await client.close();
stopServer();
process.exit(0);
