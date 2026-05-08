import { PassThrough } from "stream";
import * as k8s from "@kubernetes/client-node";
import { getK8sClientForCluster } from "../cluster-store.js";
const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };
export const workloadTools = [
    {
        name: "list_pods",
        description: "Lists pods in a specific namespace.",
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
        name: "get_pod_logs",
        description: "Retrieves logs for a specific pod.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                podName: { type: "string", description: "The name of the pod" },
                containerName: { type: "string", description: "Optional: specific container name for multi-container pods" },
                tailLines: { type: "number", description: "Number of lines to tail from the end of the logs" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "podName"],
        },
    },
    {
        name: "describe_pod",
        description: "Shows detailed pod status including container states, conditions, resource settings, and recent events.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                podName: { type: "string", description: "The name of the pod" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "podName"],
        },
    },
    {
        name: "describe_deployment",
        description: "Shows details of a deployment.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                deploymentName: { type: "string", description: "The name of the deployment" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "deploymentName"],
        },
    },
    {
        name: "list_nodes",
        description: "Lists cluster nodes.",
        inputSchema: {
            type: "object",
            properties: { ...CLUSTER_PROP },
            required: [],
        },
    },
    {
        name: "list_statefulsets",
        description: "Lists StatefulSets in a specific namespace.",
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
        name: "describe_statefulset",
        description: "Shows details of a StatefulSet.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                statefulSetName: { type: "string", description: "The name of the StatefulSet" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "statefulSetName"],
        },
    },
    {
        name: "list_daemonsets",
        description: "Lists DaemonSets in a specific namespace.",
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
        name: "describe_daemonset",
        description: "Shows details of a DaemonSet.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                daemonSetName: { type: "string", description: "The name of the DaemonSet" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "daemonSetName"],
        },
    },
];
function formatPodAge(creationTimestamp) {
    if (!creationTimestamp)
        return "unknown";
    const ageMs = Date.now() - new Date(creationTimestamp).getTime();
    const d = Math.floor(ageMs / 86400000);
    const h = Math.floor((ageMs % 86400000) / 3600000);
    const m = Math.floor((ageMs % 3600000) / 60000);
    if (d > 0)
        return `${d}d`;
    if (h > 0)
        return `${h}h`;
    return `${Math.max(m, 0)}m`;
}
export async function handleWorkloadTool(name, args) {
    const { cluster = "default" } = args;
    const { coreV1Api, appsV1Api } = await getK8sClientForCluster(cluster);
    try {
        switch (name) {
            case "list_pods": {
                const { namespace } = args;
                const res = await coreV1Api.listNamespacedPod({ namespace });
                const pods = res.items.map((p) => {
                    const readyCondition = p.status?.conditions?.find((c) => c.type === 'Ready');
                    const ready = readyCondition?.status === 'True' ? 'True' : 'False';
                    const restartCount = p.status?.containerStatuses?.[0]?.restartCount || 0;
                    const age = formatPodAge(p.metadata?.creationTimestamp);
                    return {
                        name: p.metadata?.name,
                        ready: ready,
                        status: p.status?.phase,
                        restartCount: restartCount,
                        nodeName: p.spec?.nodeName || 'none',
                        ip: p.status?.podIP,
                        age: age,
                    };
                });
                return { content: [{ type: "text", text: JSON.stringify(pods, null, 2) }] };
            }
            case "describe_pod": {
                const { namespace, podName } = args;
                const pod = await coreV1Api.readNamespacedPod({ name: podName, namespace });
                const eventsRes = await coreV1Api.listNamespacedEvent({
                    namespace,
                    fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${podName}`,
                });
                const summary = {
                    name: pod.metadata?.name,
                    namespace: pod.metadata?.namespace,
                    nodeName: pod.spec?.nodeName,
                    phase: pod.status?.phase,
                    podIP: pod.status?.podIP,
                    startTime: pod.status?.startTime,
                    conditions: (pod.status?.conditions || []).map((c) => ({
                        type: c.type,
                        status: c.status,
                        reason: c.reason,
                        message: c.message,
                    })),
                    containers: (pod.spec?.containers || []).map((c) => {
                        const cs = (pod.status?.containerStatuses || []).find((s) => s.name === c.name);
                        return {
                            name: c.name,
                            image: c.image,
                            ready: cs?.ready || false,
                            restartCount: cs?.restartCount || 0,
                            state: cs?.state || {},
                            lastState: cs?.lastState || {},
                            requests: c.resources?.requests || {},
                            limits: c.resources?.limits || {},
                        };
                    }),
                    recentEvents: (eventsRes.items || [])
                        .sort((a, b) => {
                        const at = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
                        const bt = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
                        return bt - at;
                    })
                        .slice(0, 10)
                        .map((e) => ({
                        type: e.type,
                        reason: e.reason,
                        message: e.message,
                        time: e.lastTimestamp || e.eventTime,
                    })),
                };
                return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
            }
            case "get_pod_logs": {
                const { namespace, podName, containerName, tailLines = 100 } = args;
                try {
                    const res = await coreV1Api.readNamespacedPodLog({ name: podName, namespace, container: containerName, tailLines });
                    return { content: [{ type: "text", text: res }] };
                }
                catch (err) {
                    // Some clusters return pod log responses without content-type headers.
                    // Fall back to the stream-based log reader for local-kubeconfig mode.
                    const msg = err?.message || "";
                    if (!msg.includes("No Content-Type defined") || (process.env.DISABLE_AUTH !== "true" && process.env.USE_LOCAL_KUBECONFIG !== "true")) {
                        throw err;
                    }
                    const kc = new k8s.KubeConfig();
                    kc.loadFromDefault();
                    const log = new k8s.Log(kc);
                    const stream = new PassThrough();
                    const chunks = [];
                    stream.on("data", (chunk) => {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                    });
                    await log.log(namespace, podName, containerName, stream, { tailLines, follow: false, pretty: false, timestamps: false });
                    const text = Buffer.concat(chunks).toString("utf-8");
                    return { content: [{ type: "text", text }] };
                }
            }
            case "describe_deployment": {
                const { namespace, deploymentName } = args;
                const res = await appsV1Api.readNamespacedDeployment({ name: deploymentName, namespace });
                const summary = {
                    name: res.metadata?.name,
                    namespace: res.metadata?.namespace,
                    replicas: {
                        desired: res.spec?.replicas || 0,
                        ready: res.status?.readyReplicas || 0,
                        updated: res.status?.updatedReplicas || 0,
                        available: res.status?.availableReplicas || 0,
                    },
                    containers: res.spec?.template?.spec?.containers?.map((c) => ({
                        name: c.name,
                        image: c.image,
                        requests: c.resources?.requests || {},
                        limits: c.resources?.limits || {},
                    })) || [],
                    labels: res.metadata?.labels || {},
                    conditions: res.status?.conditions?.map((c) => ({
                        type: c.type,
                        status: c.status,
                        reason: c.reason,
                        message: c.message,
                    })) || [],
                    selector: res.spec?.selector?.matchLabels || {},
                };
                return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
            }
            case "list_nodes": {
                const res = await coreV1Api.listNode();
                const nodes = res.items.map((n) => ({
                    name: n.metadata?.name,
                    status: n.status?.conditions?.find((c) => c.type === 'Ready')?.status,
                    instanceType: n.metadata?.labels?.['node.kubernetes.io/instance-type'] || 'unknown',
                }));
                return { content: [{ type: "text", text: JSON.stringify(nodes, null, 2) }] };
            }
            case "list_statefulsets": {
                const { namespace } = args;
                const res = await appsV1Api.listNamespacedStatefulSet({ namespace });
                const statefulSets = res.items.map((s) => ({
                    name: s.metadata?.name,
                    namespace: s.metadata?.namespace,
                    replicas: s.spec?.replicas || 0,
                    readyReplicas: s.status?.readyReplicas || 0,
                    currentReplicas: s.status?.currentReplicas || 0,
                    updatedReplicas: s.status?.updatedReplicas || 0,
                    currentRevision: s.status?.currentRevision,
                    updateRevision: s.status?.updateRevision,
                    serviceName: s.spec?.serviceName,
                }));
                return { content: [{ type: "text", text: JSON.stringify(statefulSets, null, 2) }] };
            }
            case "describe_statefulset": {
                const { namespace, statefulSetName } = args;
                const res = await appsV1Api.readNamespacedStatefulSet({ name: statefulSetName, namespace });
                const summary = {
                    name: res.metadata?.name,
                    namespace: res.metadata?.namespace,
                    serviceName: res.spec?.serviceName,
                    updateStrategy: res.spec?.updateStrategy || {},
                    replicas: {
                        desired: res.spec?.replicas || 0,
                        ready: res.status?.readyReplicas || 0,
                        current: res.status?.currentReplicas || 0,
                        updated: res.status?.updatedReplicas || 0,
                    },
                    containers: res.spec?.template?.spec?.containers?.map((c) => ({
                        name: c.name,
                        image: c.image,
                        requests: c.resources?.requests || {},
                        limits: c.resources?.limits || {},
                    })) || [],
                    conditions: res.status?.conditions || [],
                };
                return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
            }
            case "list_daemonsets": {
                const { namespace } = args;
                const res = await appsV1Api.listNamespacedDaemonSet({ namespace });
                const daemonSets = res.items.map((d) => ({
                    name: d.metadata?.name,
                    namespace: d.metadata?.namespace,
                    desiredNumberScheduled: d.status?.desiredNumberScheduled || 0,
                    currentNumberScheduled: d.status?.currentNumberScheduled || 0,
                    numberReady: d.status?.numberReady || 0,
                    numberAvailable: d.status?.numberAvailable || 0,
                    updatedNumberScheduled: d.status?.updatedNumberScheduled || 0,
                }));
                return { content: [{ type: "text", text: JSON.stringify(daemonSets, null, 2) }] };
            }
            case "describe_daemonset": {
                const { namespace, daemonSetName } = args;
                const res = await appsV1Api.readNamespacedDaemonSet({ name: daemonSetName, namespace });
                const summary = {
                    name: res.metadata?.name,
                    namespace: res.metadata?.namespace,
                    updateStrategy: res.spec?.updateStrategy || {},
                    scheduling: {
                        desired: res.status?.desiredNumberScheduled || 0,
                        current: res.status?.currentNumberScheduled || 0,
                        ready: res.status?.numberReady || 0,
                        available: res.status?.numberAvailable || 0,
                        updated: res.status?.updatedNumberScheduled || 0,
                    },
                    containers: res.spec?.template?.spec?.containers?.map((c) => ({
                        name: c.name,
                        image: c.image,
                        requests: c.resources?.requests || {},
                        limits: c.resources?.limits || {},
                    })) || [],
                    conditions: res.status?.conditions || [],
                };
                return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }],
            isError: true,
        };
    }
}
