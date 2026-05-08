import { getK8sClientForCluster } from "../cluster-store.js";

const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };

export const observabilityTools = [
  {
    name: "get_hpa_status",
    description: "Retrieves Horizontal Pod Autoscaler metrics and status.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        hpaName: { type: "string", description: "The name of the HPA" },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "hpaName"],
    },
  },
  {
    name: "list_warning_events",
    description: "Filters cluster events for warnings in a namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
  {
    name: "get_node_pressure",
    description: "Analyzes node resource pressure for a specific node.",
    inputSchema: {
      type: "object",
      properties: {
        nodeName: { type: "string", description: "The name of the node" },
        ...CLUSTER_PROP,
      },
      required: ["nodeName"],
    },
  },
];

export async function handleObservabilityTool(name: string, args: any) {
  const { cluster = "default" } = args;
  const { coreV1Api, autoscalingV2Api } = await getK8sClientForCluster(cluster);

  try {
    switch (name) {
      case "get_hpa_status": {
        const { namespace, hpaName } = args;
        const res = await autoscalingV2Api.readNamespacedHorizontalPodAutoscaler({ name: hpaName, namespace });
        const status = {
          currentReplicas: res.status?.currentReplicas,
          desiredReplicas: res.status?.desiredReplicas,
          conditions: res.status?.conditions,
          metrics: res.status?.currentMetrics,
        };
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }

      case "list_warning_events": {
        const { namespace } = args;
        const res = await coreV1Api.listNamespacedEvent({ namespace, fieldSelector: 'type=Warning' });
        const warnings = res.items.map((e: any) => ({
          reason: e.reason,
          message: e.message,
          object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
          time: e.lastTimestamp || e.eventTime,
        })).slice(0, 50);
        return { content: [{ type: "text", text: JSON.stringify(warnings, null, 2) }] };
      }

      case "get_node_pressure": {
        const { nodeName } = args;
        const res = await coreV1Api.readNode({ name: nodeName });
        const conditions = res.status?.conditions?.filter((c: any) => c.type.includes('Pressure'));
        return { content: [{ type: "text", text: JSON.stringify(conditions || [], null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }],
      isError: true,
    };
  }
}
