import { CoreV1Api, loadYaml } from "@kubernetes/client-node";
import { getK8sClientForCluster } from "../cluster-store.js";

const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };

export const configManagementTools = [
  {
    name: "create_configmap",
    description: "Creates a new ConfigMap. Use either basic key-value data or provide a raw YAML manifest.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        configMapName: { type: "string", description: "The name of the ConfigMap to create" },
        data: { type: "object", description: "Key-value string pairs for the ConfigMap data" },
        yamlManifest: { type: "string", description: "Full YAML manifest for advanced ConfigMap creation" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
  {
    name: "update_configmap",
    description: "Updates an existing ConfigMap by patching its data.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        configMapName: { type: "string", description: "The name of the ConfigMap to update" },
        data: { type: "object", description: "Key-value string pairs to merge into the ConfigMap" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "configMapName", "data"],
    },
  },
  {
    name: "create_secret",
    description: "Creates a new Opaque Secret. Use either basic stringData or provide a raw YAML manifest. stringData values will be base64-encoded automatically.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        secretName: { type: "string", description: "The name of the Secret to create" },
        stringData: { type: "object", description: "Plain text key-value pairs. Will be encoded automatically." },
        yamlManifest: { type: "string", description: "Full YAML manifest for advanced Secret creation" },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
  {
    name: "update_secret",
    description: "Updates an existing Secret by patching its stringData. KNOWN LIMITATION: The Kubernetes API never returns stringData on read (it is write-only); the API server stores values as base64 in the data field. This means the client-side merge only contains the keys passed in args.stringData — existing keys not included in the request will be silently dropped. If you need to preserve existing keys, read them first via get_secret and re-supply all values.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "The Kubernetes namespace" },
        secretName: { type: "string", description: "The name of the Secret to update" },
        stringData: { type: "object", description: "Plain text key-value pairs to merge into the Secret. Will be encoded automatically." },
        dryRun: { type: "boolean", description: "If true, simulates the action without making changes", default: true },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "secretName", "stringData"],
    },
  },
];

export async function handleConfigManagementTool(name: string, args: any): Promise<any> {
  const namespace = args.namespace;
  const cluster = args.cluster || "default";
  const { coreV1Api } = await getK8sClientForCluster(cluster);

  try {
    switch (name) {
      case "create_configmap": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would create ConfigMap ${args.configMapName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        let body: any;
        if (args.yamlManifest) {
          body = loadYaml(args.yamlManifest);
          if (!body.metadata) body.metadata = {};
          if (!body.metadata.namespace) body.metadata.namespace = namespace;
        } else if (args.configMapName && args.data) {
          body = {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: args.configMapName, namespace },
            data: args.data
          };
        } else {
          throw new Error("Must provide either yamlManifest or configMapName + data");
        }

        const res = await coreV1Api.createNamespacedConfigMap({ namespace, body });
        return { content: [{ type: "text", text: `Successfully created ConfigMap ${res.metadata?.name} in namespace ${namespace}.` }] };
      }

      case "update_configmap": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would update ConfigMap ${args.configMapName} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        const current = await coreV1Api.readNamespacedConfigMap({
          namespace,
          name: args.configMapName,
        });
        const mergedData = { ...((current as any).data || {}), ...(args.data || {}) };
        const patch = [{ op: "add", path: "/data", value: mergedData }];
        await coreV1Api.patchNamespacedConfigMap({
          namespace,
          name: args.configMapName,
          body: patch,
        });
        
        return { content: [{ type: "text", text: `Successfully updated ConfigMap ${args.configMapName}.` }] };
      }

      case "create_secret": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would create Secret ${args.secretName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        let body: any;
        if (args.yamlManifest) {
          body = loadYaml(args.yamlManifest);
          if (!body.metadata) body.metadata = {};
          if (!body.metadata.namespace) body.metadata.namespace = namespace;
        } else if (args.secretName && args.stringData) {
          body = {
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: { name: args.secretName, namespace },
            stringData: args.stringData
          };
        } else {
          throw new Error("Must provide either yamlManifest or secretName + stringData");
        }

        const res = await coreV1Api.createNamespacedSecret({ namespace, body });
        return { content: [{ type: "text", text: `Successfully created Secret ${res.metadata?.name} in namespace ${namespace}.` }] };
      }

      case "update_secret": {
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would update Secret ${args.secretName} in namespace ${namespace} on cluster ${cluster}.` }] };
        }

        const current = await coreV1Api.readNamespacedSecret({
          namespace,
          name: args.secretName,
        });
        // KNOWN LIMITATION: stringData is write-only in the Kubernetes API. The read above returns
        // base64-encoded `data`, not `stringData`, so (current as any).stringData is always {}.
        // The merge below is therefore equivalent to args.stringData only — existing keys not
        // supplied in this call will be overwritten/dropped. This is accepted behaviour; callers
        // that need to preserve existing keys must re-supply them explicitly.
        const mergedStringData = { ...((current as any).stringData || {}), ...(args.stringData || {}) };
        const patch = [{ op: "add", path: "/stringData", value: mergedStringData }];
        await coreV1Api.patchNamespacedSecret({
          namespace,
          name: args.secretName,
          body: patch,
        });
        
        return { content: [{ type: "text", text: `Successfully updated Secret ${args.secretName}.` }] };
      }

      default:
        throw new Error(`Unknown config management tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
    };
  }
}
