import { CustomObjectsApi } from "@kubernetes/client-node";
import { getK8sClientForCluster } from "../cluster-store.js";

const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };

// Flux CRD coordinates
const FLUX_KUSTOMIZE_GROUP = "kustomize.toolkit.fluxcd.io";
const FLUX_HELM_GROUP      = "helm.toolkit.fluxcd.io";
const FLUX_SOURCE_GROUP    = "source.toolkit.fluxcd.io";
const FLUX_NOTIFY_GROUP    = "notification.toolkit.fluxcd.io";

export const gitopsTools = [
  // ── Existing ArgoCD + Flux shared tools ────────────────────────────────────
  {
    name: "get_gitops_app_status",
    description: "Gets the health and sync status of an ArgoCD Application or Flux Kustomization.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", description: "GitOps engine ('argocd' or 'flux')" },
        namespace: { type: "string", description: "The namespace of the application/kustomization" },
        appName: { type: "string", description: "The name of the application/kustomization" },
        ...CLUSTER_PROP,
      },
      required: ["engine", "namespace", "appName"],
    },
  },
  {
    name: "get_gitops_diff",
    description: "Gets out-of-sync resources (ArgoCD) or managed resource inventory with revision drift (Flux Kustomization).",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", description: "GitOps engine ('argocd' or 'flux')" },
        namespace: { type: "string", description: "The namespace of the application/kustomization" },
        appName: { type: "string", description: "The name of the application/kustomization" },
        ...CLUSTER_PROP,
      },
      required: ["engine", "namespace", "appName"],
    },
  },
  {
    name: "sync_gitops_app",
    description: "Forces a sync/reconciliation of an ArgoCD Application, Flux Kustomization, or Flux HelmRelease.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", description: "GitOps engine ('argocd' or 'flux')" },
        namespace: { type: "string", description: "The namespace of the application/kustomization/helmrelease" },
        appName: { type: "string", description: "The name of the application/kustomization/helmrelease" },
        resourceType: { type: "string", description: "Flux only: 'kustomization' (default) or 'helmrelease'" },
        dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
        ...CLUSTER_PROP,
      },
      required: ["engine", "namespace", "appName"],
    },
  },
  {
    name: "compare_clusters",
    description: "Compares the running version/state of an application across two clusters.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", description: "GitOps engine ('argocd' or 'flux')" },
        namespace: { type: "string", description: "The namespace of the application/kustomization" },
        appName: { type: "string", description: "The name of the application/kustomization" },
        clusterA: { type: "string", description: "First cluster to compare" },
        clusterB: { type: "string", description: "Second cluster to compare" },
      },
      required: ["engine", "namespace", "appName", "clusterA", "clusterB"],
    },
  },

  // ── Flux-specific tools ────────────────────────────────────────────────────
  {
    name: "list_flux_kustomizations",
    description: "Lists all Flux Kustomizations in a namespace with their ready/suspended/revision status.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace to list Kustomizations in (omit for all namespaces)" },
        ...CLUSTER_PROP,
      },
    },
  },
  {
    name: "list_flux_helm_releases",
    description: "Lists all Flux HelmReleases in a namespace with chart name, version, and ready/suspended status.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace to list HelmReleases in (omit for all namespaces)" },
        ...CLUSTER_PROP,
      },
    },
  },
  {
    name: "get_flux_helm_release",
    description: "Gets detailed status of a Flux HelmRelease including chart version, values, and condition history.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace of the HelmRelease" },
        name: { type: "string", description: "Name of the HelmRelease" },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "name"],
    },
  },
  {
    name: "list_flux_sources",
    description: "Lists Flux source objects (GitRepository, HelmRepository, OCIRepository, Bucket) with their URL, ref, and ready status.",
    inputSchema: {
      type: "object",
      properties: {
        sourceType: {
          type: "string",
          description: "Source kind: 'gitrepository' | 'helmrepository' | 'ocirepository' | 'bucket' (omit for all)",
        },
        namespace: { type: "string", description: "Namespace to list sources in (omit for all namespaces)" },
        ...CLUSTER_PROP,
      },
    },
  },
  {
    name: "suspend_flux_resource",
    description: "Suspends reconciliation of a Flux Kustomization or HelmRelease to pause automated deployments.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: { type: "string", description: "'kustomization' or 'helmrelease'" },
        namespace: { type: "string", description: "Namespace of the resource" },
        name: { type: "string", description: "Name of the resource" },
        dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
        ...CLUSTER_PROP,
      },
      required: ["resourceType", "namespace", "name"],
    },
  },
  {
    name: "resume_flux_resource",
    description: "Resumes reconciliation of a suspended Flux Kustomization or HelmRelease.",
    inputSchema: {
      type: "object",
      properties: {
        resourceType: { type: "string", description: "'kustomization' or 'helmrelease'" },
        namespace: { type: "string", description: "Namespace of the resource" },
        name: { type: "string", description: "Name of the resource" },
        dryRun: { type: "boolean", description: "If true, simulates the action", default: true },
        ...CLUSTER_PROP,
      },
      required: ["resourceType", "namespace", "name"],
    },
  },
  {
    name: "list_flux_alerts",
    description: "Lists Flux Notification Alert objects showing which events trigger which providers.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace to list Alerts in (omit for all namespaces)" },
        ...CLUSTER_PROP,
      },
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchGitOpsApp(customObjectsApi: CustomObjectsApi, engine: string, namespace: string, appName: string): Promise<any> {
  if (engine === "argocd") {
    return customObjectsApi.getNamespacedCustomObject({
      group: "argoproj.io", version: "v1alpha1", namespace, plural: "applications", name: appName,
    });
  } else if (engine === "flux") {
    return customObjectsApi.getNamespacedCustomObject({
      group: FLUX_KUSTOMIZE_GROUP, version: "v1", namespace, plural: "kustomizations", name: appName,
    });
  }
  throw new Error(`Unsupported engine: ${engine}`);
}

function fluxReadyCondition(conditions: any[]): any {
  return conditions?.find((c: any) => c.type === "Ready") || {};
}

async function patchFluxSuspend(
  customObjectsApi: CustomObjectsApi,
  resourceType: string,
  namespace: string,
  name: string,
  suspend: boolean,
): Promise<void> {
  const { group, version, plural } = fluxGroupConfig(resourceType);
  const resource: any = await customObjectsApi.getNamespacedCustomObject({ group, version, namespace, plural, name });
  resource.spec.suspend = suspend;
  await customObjectsApi.replaceNamespacedCustomObject({ group, version, namespace, plural, name, body: resource });
}

function fluxGroupConfig(resourceType: string): { group: string; version: string; plural: string } {
  switch (resourceType.toLowerCase()) {
    case "kustomization":
      return { group: FLUX_KUSTOMIZE_GROUP, version: "v1", plural: "kustomizations" };
    case "helmrelease":
      return { group: FLUX_HELM_GROUP, version: "v2", plural: "helmreleases" };
    case "gitrepository":
      return { group: FLUX_SOURCE_GROUP, version: "v1", plural: "gitrepositories" };
    case "helmrepository":
      return { group: FLUX_SOURCE_GROUP, version: "v1", plural: "helmrepositories" };
    case "ocirepository":
      return { group: FLUX_SOURCE_GROUP, version: "v1beta2", plural: "ocirepositories" };
    case "bucket":
      return { group: FLUX_SOURCE_GROUP, version: "v1", plural: "buckets" };
    default:
      throw new Error(`Unknown Flux resource type: ${resourceType}`);
  }
}

async function listFluxResources(customObjectsApi: CustomObjectsApi, group: string, version: string, plural: string, namespace?: string): Promise<any[]> {
  if (namespace) {
    const res: any = await customObjectsApi.listNamespacedCustomObject({ group, version, namespace, plural });
    return res.items || [];
  }
  const res: any = await customObjectsApi.listClusterCustomObject({ group, version, plural });
  return res.items || [];
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleGitOpsTool(name: string, args: any): Promise<any> {
  try {
    switch (name) {

      case "get_gitops_app_status": {
        const cluster = args.cluster || "default";
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        const app = await fetchGitOpsApp(customObjectsApi, args.engine, args.namespace, args.appName);
        let statusSummary: any = {};
        if (args.engine === "argocd") {
          statusSummary = {
            health: app.status?.health?.status || "Unknown",
            sync: app.status?.sync?.status || "Unknown",
            revision: app.status?.sync?.revision || "Unknown",
          };
        } else if (args.engine === "flux") {
          const ready = fluxReadyCondition(app.status?.conditions);
          statusSummary = {
            ready: ready.status || "Unknown",
            suspended: app.spec?.suspend || false,
            message: ready.message || "",
            lastAppliedRevision: app.status?.lastAppliedRevision || "Unknown",
            lastAttemptedRevision: app.status?.lastAttemptedRevision || "Unknown",
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(statusSummary, null, 2) }] };
      }

      case "get_gitops_diff": {
        const cluster = args.cluster || "default";
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        const app = await fetchGitOpsApp(customObjectsApi, args.engine, args.namespace, args.appName);
        let diffSummary: any = {};
        if (args.engine === "argocd") {
          const outOfSync = (app.status?.resources || []).filter((r: any) => r.status !== "Synced");
          diffSummary = {
            syncStatus: app.status?.sync?.status || "Unknown",
            outOfSyncResources: outOfSync.map((r: any) => ({
              kind: r.kind, name: r.name, namespace: r.namespace, status: r.status,
            })),
          };
        } else if (args.engine === "flux") {
          // Use status.inventory for managed resource list + revision drift detection
          const inventory = (app.status?.inventory?.entries || []).map((e: any) => {
            const parts = e.id?.split("_") || [];
            return { namespace: parts[0], name: parts[1], group: parts[2], kind: parts[3], version: e.v };
          });
          diffSummary = {
            lastAppliedRevision: app.status?.lastAppliedRevision || "Unknown",
            lastAttemptedRevision: app.status?.lastAttemptedRevision || "Unknown",
            driftDetected: app.status?.lastAppliedRevision !== app.status?.lastAttemptedRevision,
            suspended: app.spec?.suspend || false,
            managedResources: inventory,
            reconcileMessage: fluxReadyCondition(app.status?.conditions).message || "",
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(diffSummary, null, 2) }] };
      }

      case "sync_gitops_app": {
        const cluster = args.cluster || "default";
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would sync ${args.engine} app '${args.appName}' in namespace '${args.namespace}' on cluster '${cluster}'.` }] };
        }
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        if (args.engine === "argocd") {
          const app = await fetchGitOpsApp(customObjectsApi, "argocd", args.namespace, args.appName);
          app.operation = { sync: { revision: app.spec?.source?.targetRevision || "HEAD" } };
          await customObjectsApi.replaceNamespacedCustomObject({
            group: "argoproj.io", version: "v1alpha1", namespace: args.namespace,
            plural: "applications", name: args.appName, body: app,
          });
        } else if (args.engine === "flux") {
          const resourceType = (args.resourceType || "kustomization").toLowerCase();
          const { group, version, plural } = fluxGroupConfig(resourceType);
          const resource: any = await customObjectsApi.getNamespacedCustomObject({
            group, version, namespace: args.namespace, plural, name: args.appName,
          });
          if (!resource.metadata.annotations) resource.metadata.annotations = {};
          resource.metadata.annotations["reconcile.fluxcd.io/requestedAt"] = new Date().toISOString();
          await customObjectsApi.replaceNamespacedCustomObject({
            group, version, namespace: args.namespace, plural, name: args.appName, body: resource,
          });
        }
        return { content: [{ type: "text", text: `Successfully triggered sync for ${args.engine} '${args.appName}' on cluster '${cluster}'.` }] };
      }

      case "compare_clusters": {
        const fetchForCluster = async (clusterName: string) => {
          try {
            const client = await getK8sClientForCluster(clusterName);
            return fetchGitOpsApp(client.customObjectsApi, args.engine, args.namespace, args.appName);
          } catch (e: any) {
            return { error: `Failed to fetch from ${clusterName}: ${e.message}` };
          }
        };
        const [appA, appB] = await Promise.all([fetchForCluster(args.clusterA), fetchForCluster(args.clusterB)]);
        const summary = (app: any, clusterName: string) => {
          if (app.error) return app;
          if (args.engine === "argocd") return { revision: app.status?.sync?.revision, syncStatus: app.status?.sync?.status };
          return { revision: app.status?.lastAppliedRevision, ready: fluxReadyCondition(app.status?.conditions).status };
        };
        const sA = summary(appA, args.clusterA);
        const sB = summary(appB, args.clusterB);
        return {
          content: [{
            type: "text", text: JSON.stringify({
              clusterA: args.clusterA, clusterB: args.clusterB,
              [args.clusterA]: sA, [args.clusterB]: sB,
              driftDetected: (!sA.error && !sB.error) && (sA.revision !== sB.revision),
            }, null, 2),
          }],
        };
      }

      // ── Flux-specific handlers ──────────────────────────────────────────────

      case "list_flux_kustomizations": {
        const cluster = args.cluster || "default";
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        const items = await listFluxResources(customObjectsApi, FLUX_KUSTOMIZE_GROUP, "v1", "kustomizations", args.namespace);
        const summary = items.map((k: any) => ({
          name: k.metadata.name,
          namespace: k.metadata.namespace,
          suspended: k.spec?.suspend || false,
          ready: fluxReadyCondition(k.status?.conditions).status || "Unknown",
          lastAppliedRevision: k.status?.lastAppliedRevision || "Unknown",
          sourceRef: `${k.spec?.sourceRef?.kind}/${k.spec?.sourceRef?.name}`,
          path: k.spec?.path || "./",
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "list_flux_helm_releases": {
        const cluster = args.cluster || "default";
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        const items = await listFluxResources(customObjectsApi, FLUX_HELM_GROUP, "v2", "helmreleases", args.namespace);
        const summary = items.map((hr: any) => ({
          name: hr.metadata.name,
          namespace: hr.metadata.namespace,
          chart: hr.spec?.chart?.spec?.chart || "Unknown",
          version: hr.spec?.chart?.spec?.version || "*",
          suspended: hr.spec?.suspend || false,
          ready: fluxReadyCondition(hr.status?.conditions).status || "Unknown",
          lastAppliedRevision: hr.status?.lastAppliedRevision || "Unknown",
          helmVersion: hr.spec?.chart?.spec?.sourceRef?.name || "Unknown",
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "get_flux_helm_release": {
        const cluster = args.cluster || "default";
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        const hr: any = await customObjectsApi.getNamespacedCustomObject({
          group: FLUX_HELM_GROUP, version: "v2", namespace: args.namespace, plural: "helmreleases", name: args.name,
        });
        const detail = {
          name: hr.metadata.name,
          namespace: hr.metadata.namespace,
          suspended: hr.spec?.suspend || false,
          chart: hr.spec?.chart?.spec?.chart,
          chartVersion: hr.spec?.chart?.spec?.version || "*",
          sourceRef: `${hr.spec?.chart?.spec?.sourceRef?.kind}/${hr.spec?.chart?.spec?.sourceRef?.name}`,
          releaseName: hr.spec?.releaseName || hr.metadata.name,
          targetNamespace: hr.spec?.targetNamespace || hr.metadata.namespace,
          lastAppliedRevision: hr.status?.lastAppliedRevision || "Unknown",
          lastAttemptedRevision: hr.status?.lastAttemptedRevision || "Unknown",
          conditions: (hr.status?.conditions || []).map((c: any) => ({
            type: c.type, status: c.status, reason: c.reason, message: c.message, lastTransitionTime: c.lastTransitionTime,
          })),
          valuesFrom: hr.spec?.valuesFrom || [],
        };
        return { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
      }

      case "list_flux_sources": {
        const cluster = args.cluster || "default";
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        const sourceTypes = args.sourceType
          ? [args.sourceType.toLowerCase()]
          : ["gitrepository", "helmrepository", "ocirepository", "bucket"];
        const results: any[] = [];
        for (const st of sourceTypes) {
          try {
            const { group, version, plural } = fluxGroupConfig(st);
            const items = await listFluxResources(customObjectsApi, group, version, plural, args.namespace);
            for (const src of items) {
              results.push({
                kind: src.kind || st,
                name: src.metadata.name,
                namespace: src.metadata.namespace,
                url: src.spec?.url || src.spec?.address || "N/A",
                ref: src.spec?.ref?.branch || src.spec?.ref?.tag || src.spec?.ref?.commit || "N/A",
                ready: fluxReadyCondition(src.status?.conditions).status || "Unknown",
                lastFetchedRevision: src.status?.artifact?.revision || "Unknown",
                suspended: src.spec?.suspend || false,
              });
            }
          } catch {
            // CRD may not be installed on this cluster — skip silently
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "suspend_flux_resource": {
        const cluster = args.cluster || "default";
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would suspend Flux ${args.resourceType} '${args.name}' in namespace '${args.namespace}' on cluster '${cluster}'.` }] };
        }
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        await patchFluxSuspend(customObjectsApi, args.resourceType, args.namespace, args.name, true);
        return { content: [{ type: "text", text: `Suspended Flux ${args.resourceType} '${args.name}' in namespace '${args.namespace}' on cluster '${cluster}'.` }] };
      }

      case "resume_flux_resource": {
        const cluster = args.cluster || "default";
        const dryRun = args.dryRun !== false;
        if (dryRun) {
          return { content: [{ type: "text", text: `[DRY RUN] Would resume Flux ${args.resourceType} '${args.name}' in namespace '${args.namespace}' on cluster '${cluster}'.` }] };
        }
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        await patchFluxSuspend(customObjectsApi, args.resourceType, args.namespace, args.name, false);
        return { content: [{ type: "text", text: `Resumed Flux ${args.resourceType} '${args.name}' in namespace '${args.namespace}' on cluster '${cluster}'.` }] };
      }

      case "list_flux_alerts": {
        const cluster = args.cluster || "default";
        const { customObjectsApi } = await getK8sClientForCluster(cluster);
        const items = await listFluxResources(customObjectsApi, FLUX_NOTIFY_GROUP, "v1beta3", "alerts", args.namespace);
        const summary = items.map((a: any) => ({
          name: a.metadata.name,
          namespace: a.metadata.namespace,
          providerRef: a.spec?.providerRef?.name || "Unknown",
          eventSeverity: a.spec?.eventSeverity || "info",
          eventSources: (a.spec?.eventSources || []).map((s: any) => `${s.kind}/${s.name}`),
          suspended: a.spec?.suspend || false,
          ready: fluxReadyCondition(a.status?.conditions).status || "Unknown",
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      default:
        throw new Error(`Unknown gitops tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
    };
  }
}
