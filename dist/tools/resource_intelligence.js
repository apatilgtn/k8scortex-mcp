import { getK8sClientForCluster } from "../cluster-store.js";
const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };
export const resourceIntelligenceTools = [
    {
        name: "set_resource_limits",
        description: "Sets CPU and Memory requests and limits for a specific container in a Deployment.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                deploymentName: { type: "string", description: "The name of the Deployment" },
                containerName: { type: "string", description: "The name of the container" },
                cpuRequest: { type: "string", description: "CPU request (e.g. '100m' or '0.1')" },
                cpuLimit: { type: "string", description: "CPU limit (e.g. '500m' or '1')" },
                memoryRequest: { type: "string", description: "Memory request (e.g. '256Mi')" },
                memoryLimit: { type: "string", description: "Memory limit (e.g. '512Mi')" },
                dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "deploymentName", "containerName"],
        },
    },
    {
        name: "get_resource_recommendations",
        description: "Suggests optimal resource requests/limits based on current metrics heuristically.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                deploymentName: { type: "string", description: "The name of the Deployment" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "deploymentName"],
        },
    },
    {
        name: "get_cluster_resource_utilisation",
        description: "Returns CPU and Memory usage vs capacity across all nodes.",
        inputSchema: {
            type: "object",
            properties: { ...CLUSTER_PROP },
            required: [],
        },
    },
];
function parseCpu(cpuString) {
    if (!cpuString)
        return 0;
    if (cpuString.endsWith('m'))
        return parseInt(cpuString.slice(0, -1), 10);
    if (cpuString.endsWith('n'))
        return parseInt(cpuString.slice(0, -1), 10) / 1000000;
    return parseFloat(cpuString) * 1000; // Return in millicores
}
function parseMemory(memString) {
    if (!memString)
        return 0;
    if (memString.endsWith('Ki'))
        return parseInt(memString.slice(0, -2), 10) * 1024;
    if (memString.endsWith('Mi'))
        return parseInt(memString.slice(0, -2), 10) * 1024 * 1024;
    if (memString.endsWith('Gi'))
        return parseInt(memString.slice(0, -2), 10) * 1024 * 1024 * 1024;
    if (memString.endsWith('m'))
        return parseInt(memString.slice(0, -1), 10) / 1000;
    return parseInt(memString, 10); // Return in bytes
}
function formatBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    const k = 1024;
    const sizes = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function isMetricsApiUnavailable(error) {
    if (typeof error === "string") {
        const plain = error.toLowerCase();
        return plain.includes("service unavailable") || plain.includes("metrics.k8s.io");
    }
    const rawBody = typeof error?.body === "string" ? error.body : error?.body?.message;
    const text = String(rawBody || error?.message || "").toLowerCase();
    return text.includes("metrics.k8s.io") || text.includes("notfound") || text.includes("the server could not find the requested resource") || text.includes("service unavailable");
}
export async function handleResourceIntelligenceTool(name, args) {
    const namespace = args.namespace;
    const cluster = args.cluster || "default";
    const { coreV1Api, appsV1Api, customObjectsApi } = await getK8sClientForCluster(cluster);
    try {
        switch (name) {
            case "set_resource_limits": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would update resources for ${args.deploymentName} container ${args.containerName}.` }] };
                }
                const res = await appsV1Api.readNamespacedDeployment({ namespace, name: args.deploymentName });
                const deployment = res;
                let found = false;
                if (deployment.spec?.template?.spec?.containers) {
                    for (const container of deployment.spec.template.spec.containers) {
                        if (container.name === args.containerName) {
                            found = true;
                            if (!container.resources)
                                container.resources = {};
                            if (!container.resources.requests)
                                container.resources.requests = {};
                            if (!container.resources.limits)
                                container.resources.limits = {};
                            if (args.cpuRequest)
                                container.resources.requests["cpu"] = args.cpuRequest;
                            if (args.memoryRequest)
                                container.resources.requests["memory"] = args.memoryRequest;
                            if (args.cpuLimit)
                                container.resources.limits["cpu"] = args.cpuLimit;
                            if (args.memoryLimit)
                                container.resources.limits["memory"] = args.memoryLimit;
                        }
                    }
                }
                if (!found && (deployment.spec?.template?.spec?.containers?.length || 0) === 1) {
                    const container = deployment.spec.template.spec.containers[0];
                    if (!container.resources)
                        container.resources = {};
                    if (!container.resources.requests)
                        container.resources.requests = {};
                    if (!container.resources.limits)
                        container.resources.limits = {};
                    if (args.cpuRequest)
                        container.resources.requests["cpu"] = args.cpuRequest;
                    if (args.memoryRequest)
                        container.resources.requests["memory"] = args.memoryRequest;
                    if (args.cpuLimit)
                        container.resources.limits["cpu"] = args.cpuLimit;
                    if (args.memoryLimit)
                        container.resources.limits["memory"] = args.memoryLimit;
                    found = true;
                }
                if (!found) {
                    throw new Error(`Container ${args.containerName} not found in Deployment ${args.deploymentName}`);
                }
                const patch = [{
                        op: "replace",
                        path: "/spec/template/spec/containers",
                        value: deployment.spec?.template?.spec?.containers || [],
                    }];
                await appsV1Api.patchNamespacedDeployment({
                    namespace,
                    name: args.deploymentName,
                    body: patch,
                });
                return { content: [{ type: "text", text: `Successfully updated resources for container ${args.containerName} in ${args.deploymentName}.` }] };
            }
            case "get_resource_recommendations": {
                // Find pods for the deployment
                const depRes = await appsV1Api.readNamespacedDeployment({ namespace, name: args.deploymentName });
                const selector = depRes.spec?.selector?.matchLabels;
                if (!selector)
                    throw new Error("Deployment has no selector");
                const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',');
                const podsRes = await coreV1Api.listNamespacedPod({ namespace, labelSelector });
                let podMetrics;
                try {
                    podMetrics = await customObjectsApi.listNamespacedCustomObject({
                        group: 'metrics.k8s.io',
                        version: 'v1beta1',
                        namespace,
                        plural: 'pods',
                        labelSelector
                    });
                }
                catch (e) {
                    if (isMetricsApiUnavailable(e)) {
                        return {
                            content: [{
                                    type: "text",
                                    text: JSON.stringify({
                                        status: "degraded",
                                        reason: "metrics_api_unavailable",
                                        message: "Pod metrics are not available. Install or enable metrics-server to receive recommendations.",
                                        remediation: "For minikube: minikube addons enable metrics-server",
                                    }, null, 2),
                                }],
                        };
                    }
                    throw e;
                }
                const recommendations = {};
                if (depRes.spec?.template?.spec?.containers) {
                    for (const container of depRes.spec.template.spec.containers) {
                        recommendations[container.name] = {
                            currentRequests: container.resources?.requests || {},
                            currentLimits: container.resources?.limits || {},
                            heuristicRecommendation: { cpu: "Unknown", memory: "Unknown" }
                        };
                        // Calculate max usage across all pods for this container
                        let maxCpuUsage = 0;
                        let maxMemUsage = 0;
                        for (const podMetric of podMetrics.items) {
                            const containerMetric = podMetric.containers.find((c) => c.name === container.name);
                            if (containerMetric) {
                                const cpu = parseCpu(containerMetric.usage.cpu);
                                const mem = parseMemory(containerMetric.usage.memory);
                                if (cpu > maxCpuUsage)
                                    maxCpuUsage = cpu;
                                if (mem > maxMemUsage)
                                    maxMemUsage = mem;
                            }
                        }
                        if (maxCpuUsage > 0 || maxMemUsage > 0) {
                            // Add 20% buffer to max usage for requests, 50% for limits
                            const reqCpu = Math.ceil(maxCpuUsage * 1.2);
                            const limCpu = Math.ceil(maxCpuUsage * 1.5);
                            const reqMem = Math.ceil(maxMemUsage * 1.2);
                            const limMem = Math.ceil(maxMemUsage * 1.5);
                            recommendations[container.name].heuristicRecommendation = {
                                requests: { cpu: `${reqCpu}m`, memory: formatBytes(reqMem).replace(' ', '') },
                                limits: { cpu: `${limCpu}m`, memory: formatBytes(limMem).replace(' ', '') }
                            };
                        }
                    }
                }
                return { content: [{ type: "text", text: JSON.stringify(recommendations, null, 2) }] };
            }
            case "get_cluster_resource_utilisation": {
                const nodesRes = await coreV1Api.listNode();
                let nodeMetrics;
                try {
                    nodeMetrics = await customObjectsApi.listClusterCustomObject({
                        group: 'metrics.k8s.io',
                        version: 'v1beta1',
                        plural: 'nodes'
                    });
                }
                catch (e) {
                    if (isMetricsApiUnavailable(e)) {
                        return {
                            content: [{
                                    type: "text",
                                    text: JSON.stringify({
                                        status: "degraded",
                                        reason: "metrics_api_unavailable",
                                        message: "Node metrics are not available. Install or enable metrics-server for utilization data.",
                                        remediation: "For minikube: minikube addons enable metrics-server",
                                        nodesObserved: nodesRes.items.length,
                                    }, null, 2),
                                }],
                        };
                    }
                    throw e;
                }
                const utilisation = nodesRes.items.map((node) => {
                    const name = node.metadata.name;
                    const metric = nodeMetrics.items.find((m) => m.metadata.name === name);
                    const capacityCpu = parseCpu(node.status.capacity.cpu);
                    const capacityMem = parseMemory(node.status.capacity.memory);
                    const usageCpu = metric ? parseCpu(metric.usage.cpu) : 0;
                    const usageMem = metric ? parseMemory(metric.usage.memory) : 0;
                    return {
                        node: name,
                        cpu: {
                            usageMillicores: Math.round(usageCpu),
                            capacityMillicores: capacityCpu,
                            percentage: capacityCpu ? Math.round((usageCpu / capacityCpu) * 100) + '%' : '0%'
                        },
                        memory: {
                            usageBytes: usageMem,
                            usageFormatted: formatBytes(usageMem),
                            capacityBytes: capacityMem,
                            capacityFormatted: formatBytes(capacityMem),
                            percentage: capacityMem ? Math.round((usageMem / capacityMem) * 100) + '%' : '0%'
                        }
                    };
                });
                return { content: [{ type: "text", text: JSON.stringify(utilisation, null, 2) }] };
            }
            default:
                throw new Error(`Unknown resource intelligence tool: ${name}`);
        }
    }
    catch (error) {
        return {
            isError: true,
            content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
        };
    }
}
