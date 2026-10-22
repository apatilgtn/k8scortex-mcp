import { getK8sClientForCluster, listRegisteredClusters } from "../cluster-store.js";
export const multiclusterTools = [
    {
        name: "list_clusters",
        description: "Lists all registered Kubernetes clusters known to K8sCortex (kubeconfig contexts, cluster registry file, or Azure Key Vault), with provider, cloud, region and labels.",
        inputSchema: {
            type: "object",
            properties: {
                cloud: { type: "string", description: "Only clusters on this cloud (e.g. eks, gke, aks, openshift, local)" },
                region: { type: "string", description: "Only clusters in this region" },
                labelSelector: { type: "string", description: "Only clusters whose registry labels match, e.g. 'env=prod,team=payments'" },
            },
            required: [],
        },
    },
    {
        name: "get_cluster_info",
        description: "Returns Kubernetes version, platform (EKS/GKE/AKS/OpenShift), node count and node details for a given cluster.",
        inputSchema: {
            type: "object",
            properties: {
                cluster: { type: "string", description: "The registered cluster name (e.g. prod-aks-au)" },
            },
            required: ["cluster"],
        },
    },
];
/** Parses "k=v,k2=v2" into a map; throws on malformed pairs. */
export function parseLabelSelector(selector) {
    return Object.fromEntries(selector.split(",").map(s => s.trim()).filter(Boolean).map((pair) => {
        const [key, value, ...rest] = pair.split("=");
        if (!key || value === undefined || rest.length)
            throw new Error(`Invalid label selector '${pair}'; expected key=value`);
        return [key.trim(), value.trim()];
    }));
}
export function filterClusters(clusters, filters) {
    const labels = filters.labelSelector ? parseLabelSelector(filters.labelSelector) : {};
    return clusters.filter(c => (!filters.cloud || c.cloud === filters.cloud)
        && (!filters.region || c.region === filters.region)
        && Object.entries(labels).every(([k, v]) => c.labels?.[k] === v));
}
/** Platform detection from node labels and served API groups; falls back to the registry's cloud. */
function detectPlatform(nodes, apiGroups, registered) {
    if (apiGroups.includes("config.openshift.io"))
        return "openshift";
    const labels = nodes[0]?.metadata?.labels ?? {};
    const providerId = nodes[0]?.spec?.providerID ?? "";
    if (labels["eks.amazonaws.com/nodegroup"] || labels["eks.amazonaws.com/compute-type"] || providerId.startsWith("aws://"))
        return "eks";
    if (labels["cloud.google.com/gke-nodepool"] || providerId.startsWith("gce://"))
        return "gke";
    if (labels["kubernetes.azure.com/cluster"] || providerId.startsWith("azure://"))
        return "aks";
    return registered;
}
export async function handleMulticlusterTool(name, args) {
    try {
        switch (name) {
            case "list_clusters": {
                const clusters = filterClusters(await listRegisteredClusters(), args ?? {});
                const summary = clusters.map(({ name, provider, cloud, region, labels }) => ({ name, provider, cloud, region, labels }));
                return {
                    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
                };
            }
            case "get_cluster_info": {
                const { cluster = "default" } = args;
                const { coreV1Api, versionApi, apisApi, cluster: entry } = await getK8sClientForCluster(cluster);
                const [nodesRes, version, groups] = await Promise.all([
                    coreV1Api.listNode(),
                    versionApi.getCode().catch(() => undefined),
                    apisApi.getAPIVersions().catch(() => undefined),
                ]);
                const nodes = nodesRes.items ?? [];
                const apiGroups = (groups?.groups ?? []).map((g) => g.name);
                const readyNodes = nodes.filter((n) => n.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True")).length;
                const info = {
                    cluster: entry.name,
                    provider: entry.provider,
                    platform: detectPlatform(nodes, apiGroups, entry.cloud),
                    region: entry.region,
                    labels: entry.labels,
                    kubernetesVersion: version?.gitVersion,
                    nodeCount: nodes.length,
                    readyNodes,
                    nodes: nodes.map((n) => ({
                        name: n.metadata?.name,
                        status: n.status?.conditions?.find((c) => c.type === "Ready")?.status,
                        kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
                        osImage: n.status?.nodeInfo?.osImage,
                        architecture: n.status?.nodeInfo?.architecture,
                        zone: n.metadata?.labels?.["topology.kubernetes.io/zone"],
                        instanceType: n.metadata?.labels?.["node.kubernetes.io/instance-type"],
                    })),
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
                };
            }
            default:
                throw new Error(`Unknown multicluster tool: ${name}`);
        }
    }
    catch (err) {
        return {
            isError: true,
            content: [{ type: "text", text: `Error executing ${name}: ${err.message}` }],
        };
    }
}
