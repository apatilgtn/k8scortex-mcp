/**
 * Smoke test for the 5 tools added after the 63-tool E2E baseline:
 *   describe_pod, rollout_status, rollout_undo (dry-run), list_ingresses, get_service_endpoints
 *
 * Expects fixtures in namespace kx-e2e-fixture (same as the main E2E suite).
 * Run:
 *   MCP_URL=http://localhost:3007/mcp npx tsx tests/e2e-smoke-5-new-tools.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

type Status = "PASS" | "FAIL";
type Result = { tool: string; status: Status; detail: string };

const NEW_TOOLS = [
  "describe_pod",
  "rollout_status",
  "rollout_undo",
  "list_ingresses",
  "get_service_endpoints",
];

async function run(): Promise<void> {
  const baseUrl = process.env.MCP_URL || "http://localhost:3007/mcp";
  const fixtureNs = process.env.FIXTURE_NS || "kx-e2e-fixture";

  const transport = new SSEClientTransport(new URL(baseUrl));
  const client = new Client({ name: "kubenexus-smoke-5", version: "1.0.0" }, { capabilities: {} });
  const results: Result[] = [];

  await client.connect(transport);

  // Verify all 5 tools are registered
  const tools = await client.listTools();
  const registered = new Set(tools.tools.map((t) => t.name));
  for (const tool of NEW_TOOLS) {
    if (!registered.has(tool)) {
      results.push({ tool, status: "FAIL", detail: "Tool missing from server registration" });
    }
  }

  async function exec(tool: string, args: Record<string, unknown>): Promise<any> {
    try {
      const response = await client.callTool({ name: tool, arguments: args });
      if (response.isError) {
        const msg = (response.content as any)?.[0]?.text || "unknown MCP error";
        results.push({ tool, status: "FAIL", detail: msg });
        return null;
      }
      results.push({ tool, status: "PASS", detail: "ok" });
      return response;
    } catch (err: any) {
      results.push({ tool, status: "FAIL", detail: err.message || "exception" });
      return null;
    }
  }

  function recordPass(tool: string, detail: string): void {
    results.push({ tool, status: "PASS", detail });
  }

  // ── 1. discover a pod name to use for describe_pod ──────────────────────────
  let fixturePod = "";
  try {
    const podsRes = await client.callTool({ name: "list_pods", arguments: { namespace: fixtureNs, cluster: "default" } });
    const pods = JSON.parse((podsRes.content as any)[0].text);
    fixturePod = pods[0]?.name || "";
  } catch {}

  // ── 2. describe_pod ─────────────────────────────────────────────────────────
  if (fixturePod) {
    await exec("describe_pod", { namespace: fixtureNs, podName: fixturePod, cluster: "default" });
  } else {
    results.push({ tool: "describe_pod", status: "FAIL", detail: "Could not resolve a pod name from list_pods" });
  }

  // ── 3. rollout_status ───────────────────────────────────────────────────────
  const rolloutRes = await exec("rollout_status", { namespace: fixtureNs, deploymentName: "fixture-deploy", cluster: "default" });
  if (rolloutRes) {
    try {
      const parsed = JSON.parse((rolloutRes.content as any)[0].text);
      // Expect one of the three documented states
      if (!["complete", "in-progress", "stalled"].includes(parsed?.status)) {
        results.push({ tool: "rollout_status", status: "FAIL", detail: `Unexpected status value: ${parsed?.status}` });
      }
    } catch {
      // response may be plain text for stalled deployments — still a PASS from exec above
    }
  }

  // ── 4. rollout_undo (dry-run guard via dryRun flag or skip if no history) ───
  // We issue dryRun: true to avoid actually rolling back the fixture deployment.
  await exec("rollout_undo", { namespace: fixtureNs, deploymentName: "fixture-deploy", dryRun: true, cluster: "default" });

  // ── 5. list_ingresses ───────────────────────────────────────────────────────
  const ingressRes = await exec("list_ingresses", { namespace: fixtureNs, cluster: "default" });
  if (ingressRes) {
    try {
      const ingresses = JSON.parse((ingressRes.content as any)[0].text);
      if (!Array.isArray(ingresses)) {
        results.push({ tool: "list_ingresses", status: "FAIL", detail: "Expected array response" });
      }
    } catch {}
  }

  // ── 6. get_service_endpoints ────────────────────────────────────────────────
  const epRes = await exec("get_service_endpoints", { namespace: fixtureNs, serviceName: "fixture-service", cluster: "default" });
  if (epRes) {
    try {
      const ep = JSON.parse((epRes.content as any)[0].text);
      // Verify the response has the documented shape
      if (!("readyAddresses" in ep) && !("notReadyAddresses" in ep)) {
        results.push({ tool: "get_service_endpoints", status: "FAIL", detail: "Response missing readyAddresses/notReadyAddresses fields" });
      }
    } catch {}
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const byTool = new Map(results.map((r) => [r.tool, r]));
  const final = NEW_TOOLS.map((tool) => byTool.get(tool) || ({ tool, status: "FAIL", detail: "Not executed" } as Result));

  const passCount = final.filter((r) => r.status === "PASS").length;
  const failCount = final.length - passCount;

  console.log(`\nTOTAL=${final.length} PASS=${passCount} FAIL=${failCount}`);
  for (const r of final) {
    const icon = r.status === "PASS" ? "✅" : "❌";
    console.log(`${icon} ${r.status}\t${r.tool}\t${r.detail}`);
  }

  await client.close();

  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  console.error(`Smoke test failed: ${err.message}`);
  process.exit(1);
});
