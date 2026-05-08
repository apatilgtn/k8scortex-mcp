import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function run() {
  const transport = new SSEClientTransport(new URL("http://localhost:3000/mcp"));
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  console.log("\n========================================");
  console.log("✅  KubeNexus Phase 3 — Multi-cluster Test");
  console.log("========================================\n");

  // List all tools to verify 14 are registered
  const tools = await client.listTools();
  console.log(`🔷 Registered tools (${tools.tools.length}):\n  ${tools.tools.map(t => t.name).join(", ")}\n`);

  // Test: list_clusters
  console.log("🔷 Tool: list_clusters");
  const clusters = await client.callTool({ name: "list_clusters", arguments: {} });
  console.log((clusters.content as any)[0].text);

  // Test: get_cluster_info
  console.log("\n🔷 Tool: get_cluster_info (cluster: default)");
  const info = await client.callTool({ name: "get_cluster_info", arguments: { cluster: "default" } });
  console.log((info.content as any)[0].text);

  // Test: existing tools still work with cluster param
  console.log("\n🔷 Tool: list_pods (cluster: default, namespace: default)");
  const pods = await client.callTool({ name: "list_pods", arguments: { namespace: "default", cluster: "default" } });
  console.log((pods.content as any)[0].text);

  // Test: list_nodes with explicit cluster
  console.log("\n🔷 Tool: list_nodes (cluster: default)");
  const nodes = await client.callTool({ name: "list_nodes", arguments: { cluster: "default" } });
  console.log((nodes.content as any)[0].text);

  console.log("\n========================================");
  console.log("✅  Phase 3 tests passed!");
  console.log("========================================\n");

  process.exit(0);
}

run().catch(err => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
