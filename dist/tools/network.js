import { loadYaml } from "@kubernetes/client-node";
import { getK8sClientForCluster } from "../cluster-store.js";
const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };
export const networkTools = [
    {
        name: "create_service",
        description: "Creates a new Service. Use either basic configuration or provide a raw YAML manifest.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                serviceName: { type: "string", description: "The name of the Service to create" },
                type: { type: "string", description: "Service type (ClusterIP, NodePort, LoadBalancer)", default: "ClusterIP" },
                port: { type: "number", description: "Port the service exposes" },
                targetPort: { type: "number", description: "Target port on the pod" },
                selector: { type: "object", description: "Label selector for the pods (e.g. { app: 'my-app' })" },
                yamlManifest: { type: "string", description: "Full YAML manifest for advanced Service creation" },
                dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
                ...CLUSTER_PROP,
            },
            required: ["namespace"],
        },
    },
    {
        name: "list_ingresses",
        description: "Lists Ingress resources in a namespace.",
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
        name: "get_service_endpoints",
        description: "Shows endpoint addresses backing a Service.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                serviceName: { type: "string", description: "Service name" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "serviceName"],
        },
    },
    {
        name: "update_ingress",
        description: "Updates an existing Ingress. Merges new rules or annotations into the existing Ingress.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                ingressName: { type: "string", description: "The name of the Ingress to update" },
                annotations: { type: "object", description: "Annotations to merge" },
                rules: { type: "array", description: "Rules to append or replace (advanced usage)", items: { type: "object" } },
                dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "ingressName"],
        },
    },
    {
        name: "create_network_policy",
        description: "Creates a new NetworkPolicy. Use either basic configuration or provide a raw YAML manifest.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                policyName: { type: "string", description: "The name of the NetworkPolicy" },
                podSelector: { type: "object", description: "Label selector for the pods this policy applies to" },
                policyTypes: { type: "array", items: { type: "string" }, description: "List of policy types (Ingress, Egress)" },
                yamlManifest: { type: "string", description: "Full YAML manifest for advanced NetworkPolicy creation" },
                dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
                ...CLUSTER_PROP,
            },
            required: ["namespace"],
        },
    },
];
export async function handleNetworkTool(name, args) {
    const namespace = args.namespace;
    const cluster = args.cluster || "default";
    const { coreV1Api, networkingV1Api } = await getK8sClientForCluster(cluster);
    try {
        switch (name) {
            case "create_service": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would create Service ${args.serviceName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
                }
                let body;
                if (args.yamlManifest) {
                    body = loadYaml(args.yamlManifest);
                    if (!body.metadata)
                        body.metadata = {};
                    if (!body.metadata.namespace)
                        body.metadata.namespace = namespace;
                }
                else if (args.serviceName && args.port && args.targetPort && args.selector) {
                    body = {
                        apiVersion: "v1",
                        kind: "Service",
                        metadata: { name: args.serviceName, namespace },
                        spec: {
                            type: args.type || "ClusterIP",
                            ports: [{ port: args.port, targetPort: args.targetPort }],
                            selector: args.selector
                        }
                    };
                }
                else {
                    throw new Error("Must provide either yamlManifest or serviceName + port + targetPort + selector");
                }
                const res = await coreV1Api.createNamespacedService({ namespace, body });
                return { content: [{ type: "text", text: `Successfully created Service ${res.metadata?.name} in namespace ${namespace}.` }] };
            }
            case "list_ingresses": {
                const res = await networkingV1Api.listNamespacedIngress({ namespace });
                const ingresses = res.items.map((i) => ({
                    name: i.metadata?.name,
                    namespace: i.metadata?.namespace,
                    className: i.spec?.ingressClassName || null,
                    hosts: (i.spec?.rules || []).map((r) => r.host).filter(Boolean),
                    addresses: (i.status?.loadBalancer?.ingress || []).map((a) => a.ip || a.hostname).filter(Boolean),
                }));
                return { content: [{ type: "text", text: JSON.stringify(ingresses, null, 2) }] };
            }
            case "get_service_endpoints": {
                const endpoints = await coreV1Api.readNamespacedEndpoints({ namespace, name: args.serviceName });
                const sets = endpoints.subsets || [];
                const summary = {
                    serviceName: args.serviceName,
                    namespace,
                    readyAddresses: sets.flatMap((s) => (s.addresses || []).map((a) => ({
                        ip: a.ip,
                        nodeName: a.nodeName || null,
                        targetRef: a.targetRef ? `${a.targetRef.kind}/${a.targetRef.name}` : null,
                    }))),
                    notReadyAddresses: sets.flatMap((s) => (s.notReadyAddresses || []).map((a) => ({
                        ip: a.ip,
                        nodeName: a.nodeName || null,
                        targetRef: a.targetRef ? `${a.targetRef.kind}/${a.targetRef.name}` : null,
                    }))),
                    ports: sets.flatMap((s) => (s.ports || []).map((p) => ({
                        name: p.name || null,
                        port: p.port,
                        protocol: p.protocol,
                    }))),
                };
                return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
            }
            case "update_ingress": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would update Ingress ${args.ingressName} in namespace ${namespace} on cluster ${cluster}.` }] };
                }
                // Read-Modify-Replace pattern for reliable updates
                const res = await networkingV1Api.readNamespacedIngress({ namespace, name: args.ingressName });
                const updatedBody = res;
                if (args.annotations) {
                    if (!updatedBody.metadata)
                        updatedBody.metadata = {};
                    updatedBody.metadata.annotations = { ...(updatedBody.metadata.annotations || {}), ...args.annotations };
                }
                if (args.rules) {
                    if (!updatedBody.spec)
                        updatedBody.spec = {};
                    updatedBody.spec.rules = args.rules;
                }
                await networkingV1Api.replaceNamespacedIngress({
                    namespace,
                    name: args.ingressName,
                    body: updatedBody
                });
                return { content: [{ type: "text", text: `Successfully updated Ingress ${args.ingressName}.` }] };
            }
            case "create_network_policy": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would create NetworkPolicy ${args.policyName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
                }
                let body;
                if (args.yamlManifest) {
                    body = loadYaml(args.yamlManifest);
                    if (!body.metadata)
                        body.metadata = {};
                    if (!body.metadata.namespace)
                        body.metadata.namespace = namespace;
                }
                else if (args.policyName && args.podSelector && args.policyTypes) {
                    body = {
                        apiVersion: "networking.k8s.io/v1",
                        kind: "NetworkPolicy",
                        metadata: { name: args.policyName, namespace },
                        spec: {
                            podSelector: { matchLabels: args.podSelector },
                            policyTypes: args.policyTypes,
                            ingress: args.policyTypes.includes("Ingress") ? [] : undefined,
                            egress: args.policyTypes.includes("Egress") ? [] : undefined
                        }
                    };
                }
                else {
                    throw new Error("Must provide either yamlManifest or policyName + podSelector + policyTypes");
                }
                const res = await networkingV1Api.createNamespacedNetworkPolicy({ namespace, body });
                return { content: [{ type: "text", text: `Successfully created NetworkPolicy ${res.metadata?.name} in namespace ${namespace}.` }] };
            }
            default:
                throw new Error(`Unknown network tool: ${name}`);
        }
    }
    catch (error) {
        return {
            isError: true,
            content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
        };
    }
}
