import { getK8sClientForCluster } from "../cluster-store.js";
const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };
export const clusterAdminTools = [
    {
        name: "cordon_node",
        description: "Marks a node as unschedulable.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node to cordon" },
                dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
                ...CLUSTER_PROP,
            },
            required: ["nodeName"],
        },
    },
    {
        name: "uncordon_node",
        description: "Marks a node as schedulable.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node to uncordon" },
                dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
                ...CLUSTER_PROP,
            },
            required: ["nodeName"],
        },
    },
    {
        name: "drain_node",
        description: "Cordons the node and evicts/deletes non-daemonset pods.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node to drain" },
                force: { type: "boolean", description: "Force deletion of pods", default: false },
                dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
                ...CLUSTER_PROP,
            },
            required: ["nodeName"],
        },
    },
    {
        name: "taint_node",
        description: "Adds a taint to a node.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node" },
                key: { type: "string", description: "Taint key" },
                value: { type: "string", description: "Taint value" },
                effect: { type: "string", description: "Taint effect (NoSchedule, PreferNoSchedule, NoExecute)" },
                dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
                ...CLUSTER_PROP,
            },
            required: ["nodeName", "key", "value", "effect"],
        },
    },
    {
        name: "remove_taint",
        description: "Removes a specific taint from a node by key.",
        inputSchema: {
            type: "object",
            properties: {
                nodeName: { type: "string", description: "Name of the node" },
                key: { type: "string", description: "Taint key to remove" },
                dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
                ...CLUSTER_PROP,
            },
            required: ["nodeName", "key"],
        },
    },
];
export async function handleClusterAdminTool(name, args) {
    const cluster = args.cluster || "default";
    const { coreV1Api } = await getK8sClientForCluster(cluster);
    try {
        switch (name) {
            case "cordon_node": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would cordon node ${args.nodeName}.` }] };
                }
                const patch = { spec: { unschedulable: true } };
                await coreV1Api.patchNode({ name: args.nodeName, body: patch });
                return { content: [{ type: "text", text: `Successfully cordoned node ${args.nodeName}.` }] };
            }
            case "uncordon_node": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would uncordon node ${args.nodeName}.` }] };
                }
                const patch = { spec: { unschedulable: false } };
                await coreV1Api.patchNode({ name: args.nodeName, body: patch });
                return { content: [{ type: "text", text: `Successfully uncordoned node ${args.nodeName}.` }] };
            }
            case "drain_node": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would drain node ${args.nodeName}.` }] };
                }
                // 1. Cordon the node
                const cordPatch = { spec: { unschedulable: true } };
                await coreV1Api.patchNode({ name: args.nodeName, body: cordPatch });
                // 2. Find pods on the node
                const podsRes = await coreV1Api.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${args.nodeName}` });
                const podsToEvict = podsRes.items.filter((pod) => {
                    // Filter out DaemonSet pods
                    const ownerReferences = pod.metadata?.ownerReferences || [];
                    return !ownerReferences.some((ref) => ref.kind === "DaemonSet");
                });
                let evicted = 0;
                let failed = 0;
                let pdbBlocked = 0;
                for (const pod of podsToEvict) {
                    try {
                        // Use eviction API instead of delete to respect PodDisruptionBudgets
                        await coreV1Api.createNamespacedPodEviction({
                            name: pod.metadata.name,
                            namespace: pod.metadata.namespace,
                            body: {
                                apiVersion: "policy/v1",
                                kind: "Eviction",
                                metadata: {
                                    name: pod.metadata.name,
                                    namespace: pod.metadata.namespace
                                },
                                deleteOptions: {
                                    gracePeriodSeconds: args.force ? 0 : 30
                                }
                            }
                        });
                        evicted++;
                    }
                    catch (e) {
                        const statusCode = e?.response?.statusCode || e?.statusCode;
                        const reason = String(e?.body?.reason || "");
                        const isPdbBlocked = statusCode === 429 || reason.includes("TooManyRequests");
                        if (isPdbBlocked) {
                            pdbBlocked++;
                        }
                        else {
                            failed++;
                        }
                    }
                }
                return { content: [{ type: "text", text: `Node ${args.nodeName} cordoned. Evicted ${evicted} pods. PDB-blocked ${pdbBlocked} pods. Failed to evict ${failed} pods.` }] };
            }
            case "taint_node": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would add taint ${args.key}=${args.value}:${args.effect} to node ${args.nodeName}.` }] };
                }
                const patch = { spec: { taints: [{ key: args.key, value: args.value, effect: args.effect }] } };
                await coreV1Api.patchNode({ name: args.nodeName, body: patch });
                return { content: [{ type: "text", text: `Successfully added taint ${args.key}=${args.value}:${args.effect} to node ${args.nodeName}.` }] };
            }
            case "remove_taint": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would remove taint ${args.key} from node ${args.nodeName}.` }] };
                }
                const node = await coreV1Api.readNode({ name: args.nodeName });
                const existing = node.spec?.taints || [];
                const filtered = existing.filter((t) => t.key !== args.key);
                const patch = { spec: { taints: filtered.length > 0 ? filtered : null } };
                await coreV1Api.patchNode({ name: args.nodeName, body: patch });
                return { content: [{ type: "text", text: `Successfully removed taint ${args.key} from node ${args.nodeName}.` }] };
            }
            default:
                throw new Error(`Unknown cluster admin tool: ${name}`);
        }
    }
    catch (error) {
        return {
            isError: true,
            content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
        };
    }
}
