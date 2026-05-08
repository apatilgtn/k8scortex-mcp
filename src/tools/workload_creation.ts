import { AppsV1Api, CoreV1Api, AutoscalingV2Api, loadYaml } from "@kubernetes/client-node";
import { getK8sClientForCluster } from "../cluster-store.js";

const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };

export const workloadCreationTools = [
  {
    name: "create_deployment",
    description: "Creates a new Deployment. Use either basic configuration or provide a raw YAML manifest.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        deploymentName: { type: "string", description: "The name of the deployment to create" },
        image: { type: "string", description: "Container image to run (if using basic config)" },
        replicas: { type: "number", description: "Number of replicas (if using basic config)", default: 1 },
        port: { type: "number", description: "Container port to expose (if using basic config)" },
        yamlManifest: { type: "string", description: "Full YAML manifest for advanced deployment creation" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
  {
    name: "delete_deployment",
    description: "Deletes an existing Deployment.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        deploymentName: { type: "string", description: "The name of the deployment to delete" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "deploymentName"],
    },
  },
  {
    name: "create_namespace",
    description: "Creates a new Kubernetes Namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespaceName: { type: "string", description: "The name of the namespace to create" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespaceName"],
    },
  },
  {
    name: "delete_namespace",
    description: "Deletes an existing Kubernetes Namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespaceName: { type: "string", description: "The name of the namespace to delete" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespaceName"],
    },
  },
  {
    name: "create_horizontal_pod_autoscaler",
    description: "Creates an HPA for a Deployment. Use either basic configuration or provide a raw YAML manifest.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        hpaName: { type: "string", description: "The name of the HPA to create" },
        targetDeployment: { type: "string", description: "The name of the target Deployment to scale" },
        minReplicas: { type: "number", description: "Minimum number of replicas" },
        maxReplicas: { type: "number", description: "Maximum number of replicas" },
        targetCPUUtilizationPercentage: { type: "number", description: "Target CPU utilization percentage", default: 80 },
        yamlManifest: { type: "string", description: "Full YAML manifest for advanced HPA creation" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
];

export async function handleWorkloadCreationTool(name: string, args: any): Promise<any> {
  const cluster = args.cluster || "default";
  const { appsV1Api, coreV1Api, autoscalingV2Api } = await getK8sClientForCluster(cluster);

  try {
    switch (name) {
      case "create_deployment": {
        const namespace = args.namespace;
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would create Deployment ${args.deploymentName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        let body: any;
        if (args.yamlManifest) {
          body = loadYaml(args.yamlManifest);
          if (!body.metadata) body.metadata = {};
          if (!body.metadata.namespace) body.metadata.namespace = namespace;
        } else if (args.deploymentName && args.image) {
          body = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: args.deploymentName, namespace },
            spec: {
              replicas: args.replicas || 1,
              selector: { matchLabels: { app: args.deploymentName } },
              template: {
                metadata: { labels: { app: args.deploymentName } },
                spec: {
                  containers: [{
                    name: args.deploymentName,
                    image: args.image,
                    ...(args.port ? { ports: [{ containerPort: args.port }] } : {})
                  }]
                }
              }
            }
          };
        } else {
          throw new Error("Must provide either yamlManifest or deploymentName + image");
        }

        const res = await appsV1Api.createNamespacedDeployment({ namespace, body });
        return { content: [{ type: "text", text: `Successfully created Deployment ${res.metadata?.name} in namespace ${namespace}.` }] };
      }

      case "delete_deployment": {
        const namespace = args.namespace;
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would delete Deployment ${args.deploymentName} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        await appsV1Api.deleteNamespacedDeployment({ namespace, name: args.deploymentName });
        return { content: [{ type: "text", text: `Successfully deleted Deployment ${args.deploymentName} in namespace ${namespace}.` }] };
      }

      case "create_namespace": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would create Namespace ${args.namespaceName} on cluster ${cluster}.` }] };
        }

        const body = {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: args.namespaceName }
        };

        const res = await coreV1Api.createNamespace({ body });
        return { content: [{ type: "text", text: `Successfully created Namespace ${res.metadata?.name}.` }] };
      }

      case "delete_namespace": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would delete Namespace ${args.namespaceName} on cluster ${cluster}.` }] };
        }

        await coreV1Api.deleteNamespace({ name: args.namespaceName });
        return { content: [{ type: "text", text: `Successfully deleted Namespace ${args.namespaceName}.` }] };
      }

      case "create_horizontal_pod_autoscaler": {
        const namespace = args.namespace;
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would create HPA ${args.hpaName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        let body: any;
        if (args.yamlManifest) {
          body = loadYaml(args.yamlManifest);
          if (!body.metadata) body.metadata = {};
          if (!body.metadata.namespace) body.metadata.namespace = namespace;
        } else if (args.hpaName && args.targetDeployment && args.minReplicas && args.maxReplicas) {
          body = {
            apiVersion: "autoscaling/v2",
            kind: "HorizontalPodAutoscaler",
            metadata: { name: args.hpaName, namespace },
            spec: {
              scaleTargetRef: {
                apiVersion: "apps/v1",
                kind: "Deployment",
                name: args.targetDeployment
              },
              minReplicas: args.minReplicas,
              maxReplicas: args.maxReplicas,
              metrics: [{
                type: "Resource",
                resource: {
                  name: "cpu",
                  target: {
                    type: "Utilization",
                    averageUtilization: args.targetCPUUtilizationPercentage || 80
                  }
                }
              }]
            }
          };
        } else {
          throw new Error("Must provide either yamlManifest or hpaName + targetDeployment + minReplicas + maxReplicas");
        }

        const res = await autoscalingV2Api.createNamespacedHorizontalPodAutoscaler({ namespace, body });
        return { content: [{ type: "text", text: `Successfully created HPA ${res.metadata?.name} in namespace ${namespace}.` }] };
      }

      default:
        throw new Error(`Unknown workload creation tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
    };
  }
}
