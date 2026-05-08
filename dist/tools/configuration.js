import { getK8sClientForCluster } from "../cluster-store.js";
const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };
export const configurationTools = [
    {
        name: "get_configmap",
        description: "Reads data from a ConfigMap.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                configMapName: { type: "string", description: "The name of the ConfigMap" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "configMapName"],
        },
    },
    {
        name: "describe_namespace_quota",
        description: "Reads resource quotas for a namespace.",
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
        name: "list_events",
        description: "Lists recent cluster events for a namespace.",
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
        name: "list_persistent_volume_claims",
        description: "Lists PersistentVolumeClaims in a specific namespace with binding and capacity details.",
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
        name: "get_effective_permissions",
        description: "Evaluates effective Kubernetes API permissions for a ServiceAccount using SubjectAccessReview checks.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace of the ServiceAccount" },
                serviceAccountName: { type: "string", description: "The ServiceAccount name to inspect" },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "serviceAccountName"],
        },
    },
];
export async function handleConfigurationTool(name, args) {
    const { cluster = "default" } = args;
    const { coreV1Api, authorizationV1Api } = await getK8sClientForCluster(cluster);
    try {
        switch (name) {
            case "get_configmap": {
                const { namespace, configMapName } = args;
                const res = await coreV1Api.readNamespacedConfigMap({ name: configMapName, namespace });
                return { content: [{ type: "text", text: JSON.stringify(res.data || {}, null, 2) }] };
            }
            case "describe_namespace_quota": {
                const { namespace } = args;
                const res = await coreV1Api.listNamespacedResourceQuota({ namespace });
                const quotas = res.items.map((q) => ({
                    name: q.metadata?.name,
                    hard: q.status?.hard,
                    used: q.status?.used,
                }));
                return { content: [{ type: "text", text: JSON.stringify(quotas, null, 2) }] };
            }
            case "list_events": {
                const { namespace } = args;
                const res = await coreV1Api.listNamespacedEvent({ namespace });
                const events = res.items.map((e) => ({
                    type: e.type,
                    reason: e.reason,
                    message: e.message,
                    object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
                    time: e.lastTimestamp || e.eventTime,
                })).slice(0, 50);
                return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
            }
            case "list_persistent_volume_claims": {
                const { namespace } = args;
                const res = await coreV1Api.listNamespacedPersistentVolumeClaim({ namespace });
                const claims = res.items.map((pvc) => ({
                    name: pvc.metadata?.name,
                    namespace: pvc.metadata?.namespace,
                    status: pvc.status?.phase,
                    volumeName: pvc.spec?.volumeName || null,
                    storageClassName: pvc.spec?.storageClassName || null,
                    requestedStorage: pvc.spec?.resources?.requests?.storage || null,
                    capacity: pvc.status?.capacity?.storage || null,
                    accessModes: pvc.status?.accessModes || pvc.spec?.accessModes || [],
                }));
                return { content: [{ type: "text", text: JSON.stringify(claims, null, 2) }] };
            }
            case "get_effective_permissions": {
                const { namespace, serviceAccountName } = args;
                const subject = `system:serviceaccount:${namespace}:${serviceAccountName}`;
                const groups = [
                    "system:serviceaccounts",
                    `system:serviceaccounts:${namespace}`,
                    "system:authenticated",
                ];
                const checks = [
                    { area: "pods", verb: "get", apiGroup: "", resource: "pods", namespace },
                    { area: "pods", verb: "list", apiGroup: "", resource: "pods", namespace },
                    { area: "pods/log", verb: "get", apiGroup: "", resource: "pods/log", namespace },
                    { area: "configmaps", verb: "get", apiGroup: "", resource: "configmaps", namespace },
                    { area: "configmaps", verb: "patch", apiGroup: "", resource: "configmaps", namespace },
                    { area: "events", verb: "list", apiGroup: "", resource: "events", namespace },
                    { area: "deployments", verb: "get", apiGroup: "apps", resource: "deployments", namespace },
                    { area: "deployments", verb: "patch", apiGroup: "apps", resource: "deployments", namespace },
                    { area: "deployments", verb: "delete", apiGroup: "apps", resource: "deployments", namespace },
                    { area: "statefulsets", verb: "get", apiGroup: "apps", resource: "statefulsets", namespace },
                    { area: "persistentvolumeclaims", verb: "get", apiGroup: "", resource: "persistentvolumeclaims", namespace },
                    { area: "nodes", verb: "list", apiGroup: "", resource: "nodes" },
                    { area: "secrets", verb: "get", apiGroup: "", resource: "secrets", namespace },
                    { area: "secrets", verb: "create", apiGroup: "", resource: "secrets", namespace },
                    { area: "secrets", verb: "patch", apiGroup: "", resource: "secrets", namespace },
                    { area: "namespaces", verb: "create", apiGroup: "", resource: "namespaces" },
                ];
                const results = [];
                for (const check of checks) {
                    const body = {
                        apiVersion: "authorization.k8s.io/v1",
                        kind: "SubjectAccessReview",
                        spec: {
                            user: subject,
                            groups,
                            resourceAttributes: {
                                namespace: check.namespace,
                                verb: check.verb,
                                group: check.apiGroup,
                                resource: check.resource,
                            },
                        },
                    };
                    const sar = await authorizationV1Api.createSubjectAccessReview({ body });
                    const status = (sar.status || {});
                    results.push({
                        area: check.area,
                        verb: check.verb,
                        resource: check.resource,
                        namespace: check.namespace || null,
                        allowed: status.allowed === true,
                        denied: status.denied === true,
                        reason: status.reason || null,
                        evaluationError: status.evaluationError || null,
                    });
                }
                const allowed = results.filter((r) => r.allowed);
                const notAllowed = results.filter((r) => !r.allowed);
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                subject,
                                cluster,
                                allowedCount: allowed.length,
                                notAllowedCount: notAllowed.length,
                                allowed,
                                notAllowed,
                            }, null, 2),
                        }],
                };
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
