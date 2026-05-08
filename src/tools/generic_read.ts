import { getK8sClientForCluster } from "../cluster-store.js";

const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };

function normalizeApiGroup(group?: string): string {
  if (!group || group === "core") return "";
  return group;
}

export const genericReadTools = [
  {
    name: "list_k8s_resources",
    description: "Generic read: list Kubernetes resources by group/version/resource.",
    inputSchema: {
      type: "object",
      properties: {
        apiGroup: { type: "string", description: "API group (e.g. 'apps', 'rbac.authorization.k8s.io'). Use '' or 'core' for core/v1 resources." },
        version: { type: "string", description: "API version (e.g. 'v1')" },
        resource: { type: "string", description: "Plural resource name (e.g. 'statefulsets', 'daemonsets', 'persistentvolumeclaims', 'roles')" },
        namespace: { type: "string", description: "Namespace for namespaced resources" },
        namespaced: { type: "boolean", description: "Whether the target resource is namespaced", default: true },
        labelSelector: { type: "string", description: "Optional label selector" },
        ...CLUSTER_PROP,
      },
      required: ["version", "resource"],
    },
  },
  {
    name: "get_k8s_resource",
    description: "Generic read: get a single Kubernetes resource by group/version/resource/name.",
    inputSchema: {
      type: "object",
      properties: {
        apiGroup: { type: "string", description: "API group (e.g. 'apps', 'rbac.authorization.k8s.io'). Use '' or 'core' for core/v1 resources." },
        version: { type: "string", description: "API version (e.g. 'v1')" },
        resource: { type: "string", description: "Plural resource name" },
        name: { type: "string", description: "Resource name" },
        namespace: { type: "string", description: "Namespace for namespaced resources" },
        namespaced: { type: "boolean", description: "Whether the target resource is namespaced", default: true },
        ...CLUSTER_PROP,
      },
      required: ["version", "resource", "name"],
    },
  },
];

export async function handleGenericReadTool(name: string, args: any): Promise<any> {
  const cluster = args.cluster || "default";
  const { coreV1Api, customObjectsApi } = await getK8sClientForCluster(cluster);

  const apiGroup = normalizeApiGroup(args.apiGroup);
  const version = args.version;
  const resource = args.resource;
  const namespaced = args.namespaced !== false;
  const namespace = args.namespace;

  try {
    if (name === "list_k8s_resources") {
      if (!apiGroup) {
        switch (resource) {
          case "persistentvolumeclaims": {
            if (!namespace) throw new Error("namespace is required for persistentvolumeclaims");
            const res = await coreV1Api.listNamespacedPersistentVolumeClaim({ namespace, labelSelector: args.labelSelector });
            return { content: [{ type: "text", text: JSON.stringify(res.items, null, 2) }] };
          }
          case "pods": {
            if (!namespace) throw new Error("namespace is required for pods");
            const res = await coreV1Api.listNamespacedPod({ namespace, labelSelector: args.labelSelector });
            return { content: [{ type: "text", text: JSON.stringify(res.items, null, 2) }] };
          }
          case "configmaps": {
            if (!namespace) throw new Error("namespace is required for configmaps");
            const res = await coreV1Api.listNamespacedConfigMap({ namespace, labelSelector: args.labelSelector });
            return { content: [{ type: "text", text: JSON.stringify(res.items, null, 2) }] };
          }
          case "services": {
            if (!namespace) throw new Error("namespace is required for services");
            const res = await coreV1Api.listNamespacedService({ namespace, labelSelector: args.labelSelector });
            return { content: [{ type: "text", text: JSON.stringify(res.items, null, 2) }] };
          }
          case "namespaces": {
            const res = await coreV1Api.listNamespace();
            return { content: [{ type: "text", text: JSON.stringify(res.items, null, 2) }] };
          }
          case "nodes": {
            const res = await coreV1Api.listNode({ labelSelector: args.labelSelector });
            return { content: [{ type: "text", text: JSON.stringify(res.items, null, 2) }] };
          }
          default:
            throw new Error(`Unsupported core/v1 resource '${resource}' for generic read`);
        }
      }

      if (namespaced) {
        if (!namespace) throw new Error("namespace is required when namespaced=true");
        const res = await customObjectsApi.listNamespacedCustomObject({
          group: apiGroup,
          version,
          namespace,
          plural: resource,
          labelSelector: args.labelSelector,
        });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      const res = await customObjectsApi.listClusterCustomObject({
        group: apiGroup,
        version,
        plural: resource,
        labelSelector: args.labelSelector,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (name === "get_k8s_resource") {
      const targetName = args.name;
      if (!apiGroup) {
        switch (resource) {
          case "persistentvolumeclaims": {
            if (!namespace) throw new Error("namespace is required for persistentvolumeclaims");
            const res = await coreV1Api.readNamespacedPersistentVolumeClaim({ namespace, name: targetName });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "pods": {
            if (!namespace) throw new Error("namespace is required for pods");
            const res = await coreV1Api.readNamespacedPod({ namespace, name: targetName });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "configmaps": {
            if (!namespace) throw new Error("namespace is required for configmaps");
            const res = await coreV1Api.readNamespacedConfigMap({ namespace, name: targetName });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "services": {
            if (!namespace) throw new Error("namespace is required for services");
            const res = await coreV1Api.readNamespacedService({ namespace, name: targetName });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "namespaces": {
            const res = await coreV1Api.readNamespace({ name: targetName });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          case "nodes": {
            const res = await coreV1Api.readNode({ name: targetName });
            return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
          }
          default:
            throw new Error(`Unsupported core/v1 resource '${resource}' for generic read`);
        }
      }

      if (namespaced) {
        if (!namespace) throw new Error("namespace is required when namespaced=true");
        const res = await customObjectsApi.getNamespacedCustomObject({
          group: apiGroup,
          version,
          namespace,
          plural: resource,
          name: targetName,
        });
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      const res = await customObjectsApi.getClusterCustomObject({
        group: apiGroup,
        version,
        plural: resource,
        name: targetName,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    throw new Error(`Unknown generic read tool: ${name}`);
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
    };
  }
}