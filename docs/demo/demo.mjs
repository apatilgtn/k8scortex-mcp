// Scripted K8sCortex session for the README demo (docs/demo/README.md).
// Every result shown is a real MCP tool call against the current kube context; nothing is mocked
// and no LLM is involved. Two users connect over Streamable HTTP with signed test tokens.
import * as k8s from "@kubernetes/client-node";
import { c, out, sleep, plain, audit, startServer, stopServer, connect, tool as showTool, ask, waitForRollout } from "./lib.mjs";

const NS = process.env.DEMO_NAMESPACE || "shop";
// Writes must name their cluster when the kubeconfig has several contexts; use the current one
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const CLUSTER = process.env.DEMO_CLUSTER || kc.getCurrentContext();
const tool = (client, name, args, show) => showTool(client, name, { ...args, cluster: CLUSTER }, show, { hide: ["namespace", "cluster"] });

await startServer();
out(`${c.bold}K8sCortex${c.reset} ${c.dim}· real MCP calls against a kind cluster · no LLM in this recording${c.reset}`);
const priya = await connect("priya", ["developer"]);
const sam = await connect("sam", ["release-manager"]);

await ask("priya", "developer", `why is checkout crashing in ${NS}?`);
let crashing;
await tool(priya, "list_pods", { namespace: NS }, (t) => JSON.parse(t).filter((p) => p.reason !== "Terminating").map((p) => {
  if (p.reason && !crashing) crashing = p.name;
  const state = p.reason ? `${c.red}${p.reason}${c.reset}` : `${c.green}${p.status}${c.reset}`;
  return `${p.name.padEnd(28)} ${state}  ${c.dim}restarts ${p.restartCount}${c.reset}`;
}));
await tool(priya, "get_pod_logs", { namespace: NS, podName: crashing, tailLines: 2 }, (t) =>
  t.trim().split("\n").map((l) => (l.startsWith("ERROR") ? `${c.red}${l}${c.reset}` : l)));

await ask("priya", "developer", "roll it back");
await tool(priya, "rollout_undo", { namespace: NS, deploymentName: "checkout", dryRun: false }, (t) =>
  [`${c.yellow}✗ ${plain(t).split(". ")[0]}${c.reset} ${c.dim}— needs release-manager${c.reset}`]);

await ask("sam", "release-manager", "roll checkout back to the last good version");
await tool(sam, "rollout_undo", { namespace: NS, deploymentName: "checkout" }, (t) =>
  [`${c.yellow}${t.replace(/ on cluster '[^']*'/, "")}${c.reset}`]);
await ask("sam", "release-manager", "looks right, do it");
await tool(sam, "rollout_undo", { namespace: NS, deploymentName: "checkout", dryRun: false }, (t, ok) =>
  [ok ? `${c.green}✓ ${t.replace(/ on cluster '[^']*'/, "")}${c.reset}` : `${c.red}${t}${c.reset}`]);
await waitForRollout(sam, { namespace: NS, deploymentName: "checkout", cluster: CLUSTER });
await tool(sam, "rollout_status", { namespace: NS, deploymentName: "checkout" }, (t) => {
  const s = JSON.parse(t);
  return [`${c.green}${s.status}${c.reset} · ${s.replicas.available}/${s.replicas.desired} available`];
});

out();
out(`${c.bold}audit log${c.reset} ${c.dim}(stdout of the server, one JSON record per call)${c.reset}`);
// Write tools default to a dry run unless the call passed dryRun: false
const label = (r) => (r.tool === "rollout_undo" && r.status === "success" && r.arguments?.dryRun !== false ? "rollout_undo (dry run)" : r.tool);
// Consecutive identical records (rollout_status polling while the rollback settles) are shown once
const rows = audit.filter((r, i) => i === 0 || r.userOid !== audit[i - 1].userOid || label(r) !== label(audit[i - 1]) || r.status !== audit[i - 1].status);
for (const r of rows) {
  const colour = r.status === "denied" ? c.yellow : r.status === "success" ? c.green : c.red;
  out(`  ${r.userOid.padEnd(6)} ${label(r).padEnd(23)} ${colour}${r.status}${c.reset}`);
}
await sleep(3500);

await priya.close();
await sam.close();
stopServer();
process.exit(0);
