import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const baseUrl = process.env.MCP_URL || "http://localhost:3005/mcp";
  const namespace = `kubenexus-e2e-${Math.floor(Math.random() * 100000)}`;

  const transport = new SSEClientTransport(new URL(baseUrl));
  const client = new Client({ name: "kubenexus-e2e", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((t) => t.name));

  const expectedTools = [
    "list_pods",
    "list_statefulsets",
    "list_daemonsets",
    "list_persistent_volume_claims",
    "get_effective_permissions",
    "list_k8s_resources",
    "get_k8s_resource",
    "create_namespace",
    "delete_namespace",
  ];

  for (const name of expectedTools) {
    assert(toolNames.has(name), `Missing expected tool: ${name}`);
  }

  const readCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "list_nodes", arguments: { cluster: "default" } },
    { name: "list_pods", arguments: { namespace: "kube-system", cluster: "default" } },
    { name: "list_statefulsets", arguments: { namespace: "kube-system", cluster: "default" } },
    { name: "list_daemonsets", arguments: { namespace: "kube-system", cluster: "default" } },
    { name: "list_persistent_volume_claims", arguments: { namespace: "default", cluster: "default" } },
    {
      name: "list_k8s_resources",
      arguments: {
        apiGroup: "apps",
        version: "v1",
        resource: "daemonsets",
        namespace: "kube-system",
        namespaced: true,
        cluster: "default",
      },
    },
    {
      name: "get_effective_permissions",
      arguments: {
        namespace: "default",
        serviceAccountName: "default",
        cluster: "default",
      },
    },
    {
      name: "scale_deployment",
      arguments: {
        namespace: "kube-system",
        deploymentName: "coredns",
        replicas: 2,
        dryRun: true,
        cluster: "default",
      },
    },
  ];

  for (const call of readCalls) {
    const result = await client.callTool(call);
    assert(!result.isError, `Tool ${call.name} failed: ${(result.content as any)?.[0]?.text || "unknown error"}`);
  }

  const createNs = await client.callTool({
    name: "create_namespace",
    arguments: { namespaceName: namespace, dryRun: false, cluster: "default" },
  });
  assert(!createNs.isError, `Failed to create namespace: ${(createNs.content as any)?.[0]?.text || "unknown error"}`);

  const getNs = await client.callTool({
    name: "get_k8s_resource",
    arguments: {
      version: "v1",
      resource: "namespaces",
      name: namespace,
      namespaced: false,
      cluster: "default",
    },
  });
  assert(!getNs.isError, `Failed to get created namespace: ${(getNs.content as any)?.[0]?.text || "unknown error"}`);

  const deleteNs = await client.callTool({
    name: "delete_namespace",
    arguments: { namespaceName: namespace, dryRun: false, cluster: "default" },
  });
  assert(!deleteNs.isError, `Failed to delete namespace: ${(deleteNs.content as any)?.[0]?.text || "unknown error"}`);

  await client.close();
  console.log("E2E minikube test passed.");
}

run().catch((error) => {
  console.error(`E2E minikube test failed: ${error.message}`);
  process.exit(1);
});
