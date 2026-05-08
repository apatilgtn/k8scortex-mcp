import { getK8sClientForCluster, listRegisteredClusters } from "../cluster-store.js";

export const multiclusterTools = [
  {
    name: "list_clusters",
    description: "Lists all registered Kubernetes clusters managed by KubeNexus.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_cluster_info",
    description: "Returns API server URL, Kubernetes version, node count, and cloud metadata for a given cluster.",
    inputSchema: {
      type: "object",
      properties: {
        cluster: { type: "string", description: "The registered cluster name (e.g. prod-aks-au)" },
      },
      required: ["cluster"],
    },
  },
];

export async function handleMulticlusterTool(name: string, args: any) {
  try {
    switch (name) {
      case "list_clusters": {
        const clusters = await listRegisteredClusters();
        return {
          content: [{ type: "text", text: JSON.stringify(clusters, null, 2) }],
        };
      }

      case "get_cluster_info": {
        const { cluster = "default" } = args;
        const { coreV1Api } = await getK8sClientForCluster(cluster);
        const nodesRes = await coreV1Api.listNode();
        const nodes = nodesRes.items ?? [];
        const readyNodes = nodes.filter((n: any) =>
          n.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True")
        ).length;

        const info = {
          cluster,
          nodeCount: nodes.length,
          readyNodes,
          nodes: nodes.map((n: any) => ({
            name: n.metadata?.name,
            status: n.status?.conditions?.find((c: any) => c.type === "Ready")?.status,
            kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
            osImage: n.status?.nodeInfo?.osImage,
            architecture: n.status?.nodeInfo?.architecture,
          })),
        };

        return {
          content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown multicluster tool: ${name}`);
    }
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error executing ${name}: ${err.message}` }],
    };
  }
}
