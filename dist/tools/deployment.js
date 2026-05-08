import { getK8sClientForCluster } from "../cluster-store.js";
const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };
export const deploymentTools = [
    {
        name: "scale_deployment",
        description: "Scales replicas for a deployment.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                deploymentName: { type: "string", description: "The name of the deployment" },
                replicas: { type: "number", description: "The new replica count" },
                dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "deploymentName", "replicas"],
        },
    },
    {
        name: "rollout_status",
        description: "Checks deployment rollout status (complete, in-progress, or stalled).",
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
        name: "rollout_undo",
        description: "Rolls a deployment back to the previous ReplicaSet template.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                deploymentName: { type: "string", description: "The name of the deployment" },
                dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "deploymentName"],
        },
    },
    {
        name: "restart_pod",
        description: "Deletes a pod to force a restart. Usually managed by a deployment/replicaset.",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string", description: "The Kubernetes namespace" },
                podName: { type: "string", description: "The name of the pod to restart" },
                dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
                ...CLUSTER_PROP,
            },
            required: ["namespace", "podName"],
        },
    },
];
export async function handleDeploymentTool(name, args) {
    const { cluster = "default" } = args;
    const { coreV1Api, appsV1Api } = await getK8sClientForCluster(cluster);
    const dryRun = args.dryRun !== false; // Default to true if not explicitly false
    try {
        switch (name) {
            case "scale_deployment": {
                const { namespace, deploymentName, replicas } = args;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would scale deployment ${deploymentName} in ${namespace} on cluster '${cluster}' to ${replicas} replicas.` }] };
                }
                const patch = { spec: { replicas } };
                await appsV1Api.patchNamespacedDeployment({ name: deploymentName, namespace, body: patch });
                return { content: [{ type: "text", text: `Successfully scaled deployment ${deploymentName} to ${replicas} replicas on cluster '${cluster}'.` }] };
            }
            case "rollout_status": {
                const { namespace, deploymentName } = args;
                const dep = await appsV1Api.readNamespacedDeployment({ name: deploymentName, namespace });
                const desired = dep.spec?.replicas || 0;
                const updated = dep.status?.updatedReplicas || 0;
                const available = dep.status?.availableReplicas || 0;
                const progressing = dep.status?.conditions?.find((c) => c.type === "Progressing");
                const availableCondition = dep.status?.conditions?.find((c) => c.type === "Available");
                const observedGeneration = dep.status?.observedGeneration || 0;
                const generation = dep.metadata?.generation || 0;
                let status = "in-progress";
                if (progressing?.reason === "ProgressDeadlineExceeded") {
                    status = "stalled";
                }
                else if (observedGeneration >= generation &&
                    updated === desired &&
                    available === desired &&
                    availableCondition?.status === "True") {
                    status = "complete";
                }
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                name: dep.metadata?.name,
                                namespace: dep.metadata?.namespace,
                                status,
                                replicas: { desired, updated, available },
                                progressing: progressing || null,
                                availableCondition: availableCondition || null,
                            }, null, 2),
                        }],
                };
            }
            case "rollout_undo": {
                const { namespace, deploymentName } = args;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would roll back deployment ${deploymentName} in ${namespace} on cluster '${cluster}' to the previous ReplicaSet template.` }] };
                }
                const dep = await appsV1Api.readNamespacedDeployment({ name: deploymentName, namespace });
                const selector = dep.spec?.selector?.matchLabels || {};
                const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
                const rsList = await appsV1Api.listNamespacedReplicaSet({ namespace, labelSelector });
                const owned = (rsList.items || []).filter((rs) => (rs.metadata?.ownerReferences || []).some((o) => o.kind === "Deployment" && o.name === deploymentName));
                const parsed = owned
                    .map((rs) => ({
                    rs,
                    revision: Number(rs.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0"),
                }))
                    .filter((x) => Number.isFinite(x.revision) && x.revision > 0)
                    .sort((a, b) => b.revision - a.revision);
                if (parsed.length < 2) {
                    throw new Error(`No previous ReplicaSet found for deployment ${deploymentName}.`);
                }
                const previous = parsed[1].rs;
                if (!previous.spec?.template) {
                    throw new Error(`Previous ReplicaSet template is missing for deployment ${deploymentName}.`);
                }
                const body = dep;
                body.spec = body.spec || {};
                body.spec.template = previous.spec.template;
                await appsV1Api.replaceNamespacedDeployment({ name: deploymentName, namespace, body });
                return { content: [{ type: "text", text: `Successfully rolled back deployment ${deploymentName} to revision ${parsed[1].revision} on cluster '${cluster}'.` }] };
            }
            case "restart_pod": {
                const { namespace, podName } = args;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would delete pod ${podName} in ${namespace} on cluster '${cluster}' to trigger a restart.` }] };
                }
                await coreV1Api.deleteNamespacedPod({ name: podName, namespace });
                return { content: [{ type: "text", text: `Successfully deleted pod ${podName} in ${namespace} on cluster '${cluster}'.` }] };
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
