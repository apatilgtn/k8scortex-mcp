import { BatchV1Api, loadYaml } from "@kubernetes/client-node";
import { getK8sClientForCluster } from "../cluster-store.js";

const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };

export const jobTools = [
  {
    name: "list_jobs",
    description: "Lists Jobs in a specific namespace.",
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
    name: "create_job",
    description: "Creates a new Job. Use either basic configuration or provide a raw YAML manifest.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        jobName: { type: "string", description: "The name of the job to create" },
        image: { type: "string", description: "Container image to run (if using basic config)" },
        command: { type: "array", items: { type: "string" }, description: "Command to run (if using basic config)" },
        yamlManifest: { type: "string", description: "Full YAML manifest for advanced job creation" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
  {
    name: "list_cronjobs",
    description: "Lists CronJobs in a specific namespace.",
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
    name: "suspend_cronjob",
    description: "Suspends an active CronJob.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        cronJobName: { type: "string", description: "The name of the CronJob to suspend" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "cronJobName"],
    },
  },
  {
    name: "resume_cronjob",
    description: "Resumes a suspended CronJob.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        cronJobName: { type: "string", description: "The name of the CronJob to resume" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "cronJobName"],
    },
  },
];

export async function handleJobTool(name: string, args: any): Promise<any> {
  const namespace = args.namespace;
  const cluster = args.cluster || "default";
  const { batchV1Api } = await getK8sClientForCluster(cluster);

  try {
    switch (name) {
      case "list_jobs": {
        const res = await batchV1Api.listNamespacedJob({ namespace });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(res.items.map((j: any) => ({
              name: j.metadata?.name,
              status: j.status?.conditions?.find((c: any) => c.type === 'Complete' && c.status === 'True') ? 'Complete' :
                      j.status?.conditions?.find((c: any) => c.type === 'Failed' && c.status === 'True') ? 'Failed' : 'Active',
              startTime: j.status?.startTime,
              completionTime: j.status?.completionTime,
              active: j.status?.active || 0,
              succeeded: j.status?.succeeded || 0,
              failed: j.status?.failed || 0
            })), null, 2)
          }]
        };
      }

      case "list_cronjobs": {
        const res = await batchV1Api.listNamespacedCronJob({ namespace });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(res.items.map((cj: any) => ({
              name: cj.metadata?.name,
              schedule: cj.spec?.schedule,
              suspend: cj.spec?.suspend || false,
              active: cj.status?.active?.length || 0,
              lastScheduleTime: cj.status?.lastScheduleTime
            })), null, 2)
          }]
        };
      }

      case "create_job": {
        const dryRun = args.dryRun !== false;
        
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would create job ${args.jobName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        let body: any;
        if (args.yamlManifest) {
          body = loadYaml(args.yamlManifest);
          if (!body.metadata) body.metadata = {};
          if (!body.metadata.namespace) body.metadata.namespace = namespace;
        } else if (args.jobName && args.image) {
          body = {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: { name: args.jobName, namespace },
            spec: {
              template: {
                spec: {
                  containers: [{
                    name: args.jobName,
                    image: args.image,
                    command: args.command
                  }],
                  restartPolicy: "Never"
                }
              }
            }
          };
        } else {
          throw new Error("Must provide either yamlManifest or jobName + image");
        }

        const res = await batchV1Api.createNamespacedJob({ namespace, body });
        return { content: [{ type: "text", text: `Successfully created job ${res.metadata?.name} in namespace ${namespace}.` }] };
      }

      case "suspend_cronjob": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would suspend CronJob ${args.cronJobName} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        const patch = [{ op: "add", path: "/spec/suspend", value: true }];
        await batchV1Api.patchNamespacedCronJob({
          namespace,
          name: args.cronJobName,
          body: patch,
        });
        
        return { content: [{ type: "text", text: `Successfully suspended CronJob ${args.cronJobName}.` }] };
      }

      case "resume_cronjob": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would resume CronJob ${args.cronJobName} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        const patch = [{ op: "add", path: "/spec/suspend", value: false }];
        await batchV1Api.patchNamespacedCronJob({
          namespace,
          name: args.cronJobName,
          body: patch,
        });
        
        return { content: [{ type: "text", text: `Successfully resumed CronJob ${args.cronJobName}.` }] };
      }

      default:
        throw new Error(`Unknown job tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
    };
  }
}
