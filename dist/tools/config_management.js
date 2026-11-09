import { loadYaml, PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";
import { getK8sClientForCluster } from "../cluster-store.js";
const MERGE_PATCH = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);
/**
 * Validates key-value data for a ConfigMap or Secret. Numbers and booleans are stored as strings, as
 * `kubectl create --from-literal` would; anything else (null, objects, arrays) is rejected rather than
 * passed through, and an empty map is rejected so an update can never report success while changing nothing.
 */
export function toStringMap(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${field} must be an object of key-value pairs`);
    }
    const entries = Object.entries(value);
    if (!entries.length)
        throw new Error(`${field} must contain at least one key`);
    const out = {};
    for (const [key, v] of entries) {
        if (typeof v === "string")
            out[key] = v;
        else if (typeof v === "number" || typeof v === "boolean")
            out[key] = String(v);
        else
            throw new Error(`${field}.${key} must be a string, number or boolean, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`);
    }
    return out;
}
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
        description: "Updates an existing Secret: each key in stringData is added or replaced, and keys you do not pass are kept unchanged. Values are never returned.",
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
export async function handleConfigManagementTool(name, args) {
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
                let body;
                if (args.yamlManifest) {
                    body = loadYaml(args.yamlManifest);
                    if (!body.metadata)
                        body.metadata = {};
                    if (!body.metadata.namespace)
                        body.metadata.namespace = namespace;
                }
                else if (args.configMapName && args.data) {
                    body = {
                        apiVersion: "v1",
                        kind: "ConfigMap",
                        metadata: { name: args.configMapName, namespace },
                        data: toStringMap(args.data, "data")
                    };
                }
                else {
                    throw new Error("Must provide either yamlManifest or configMapName + data");
                }
                const res = await coreV1Api.createNamespacedConfigMap({ namespace, body });
                return { content: [{ type: "text", text: `Successfully created ConfigMap ${res.metadata?.name} in namespace ${namespace}.` }] };
            }
            case "update_configmap": {
                const data = toStringMap(args.data, "data");
                const keys = Object.keys(data).join(", ");
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would set keys ${keys} on ConfigMap ${args.configMapName} in namespace ${namespace} on cluster ${cluster}.` }] };
                }
                // A merge patch is applied atomically by the API server: passed keys are set and the rest kept,
                // so concurrent updates to different keys cannot overwrite each other (no read-modify-write)
                await coreV1Api.patchNamespacedConfigMap({
                    namespace,
                    name: args.configMapName,
                    body: { data },
                }, MERGE_PATCH);
                return { content: [{ type: "text", text: `Successfully updated ConfigMap ${args.configMapName} (keys: ${keys}).` }] };
            }
            case "create_secret": {
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would create Secret ${args.secretName || 'from YAML'} in namespace ${namespace} on cluster ${cluster}.` }] };
                }
                let body;
                if (args.yamlManifest) {
                    body = loadYaml(args.yamlManifest);
                    if (!body.metadata)
                        body.metadata = {};
                    if (!body.metadata.namespace)
                        body.metadata.namespace = namespace;
                }
                else if (args.secretName && args.stringData) {
                    body = {
                        apiVersion: "v1",
                        kind: "Secret",
                        type: "Opaque",
                        metadata: { name: args.secretName, namespace },
                        stringData: toStringMap(args.stringData, "stringData")
                    };
                }
                else {
                    throw new Error("Must provide either yamlManifest or secretName + stringData");
                }
                const res = await coreV1Api.createNamespacedSecret({ namespace, body });
                return { content: [{ type: "text", text: `Successfully created Secret ${res.metadata?.name} in namespace ${namespace}.` }] };
            }
            case "update_secret": {
                const stringData = toStringMap(args.stringData, "stringData");
                const keys = Object.keys(stringData).join(", ");
                const dryRun = args.dryRun !== false;
                if (dryRun) {
                    return { content: [{ type: "text", text: `[DRY RUN] Would set keys ${keys} on Secret ${args.secretName} in namespace ${namespace} on cluster ${cluster}.` }] };
                }
                // The API server merges stringData into the existing data: passed keys are replaced, the rest kept
                await coreV1Api.patchNamespacedSecret({
                    namespace,
                    name: args.secretName,
                    body: { stringData },
                }, MERGE_PATCH);
                // Key names only: values are never echoed back
                return { content: [{ type: "text", text: `Successfully updated Secret ${args.secretName} (keys: ${keys}).` }] };
            }
            default:
                throw new Error(`Unknown config management tool: ${name}`);
        }
    }
    catch (error) {
        return {
            isError: true,
            content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
        };
    }
}
