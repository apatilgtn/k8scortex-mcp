import * as k8s from "@kubernetes/client-node";
import { ClusterRegistry, createRegistryFromEnv } from "./clusters/registry.js";
import { ClusterEntry } from "./clusters/types.js";

export interface CachedClient {
  kubeConfig: k8s.KubeConfig;
  cluster: ClusterEntry;
  coreV1Api: k8s.CoreV1Api;
  appsV1Api: k8s.AppsV1Api;
  authorizationV1Api: k8s.AuthorizationV1Api;
  autoscalingV2Api: k8s.AutoscalingV2Api;
  batchV1Api: k8s.BatchV1Api;
  networkingV1Api: k8s.NetworkingV1Api;
  customObjectsApi: k8s.CustomObjectsApi;
  versionApi: k8s.VersionApi;
  apisApi: k8s.ApisApi;
  expiresAt: number;
}

let registry: ClusterRegistry | undefined;

// Client cache keyed by resolved cluster name; expiry follows each provider's credential lifetime
const clientCache = new Map<string, CachedClient>();
const inFlight = new Map<string, Promise<CachedClient>>();

export function getClusterRegistry(): ClusterRegistry {
  registry ??= createRegistryFromEnv();
  return registry;
}

/** Replaces the registry (tests) and clears cached clients. */
export function setClusterRegistry(next: ClusterRegistry | undefined) {
  registry = next;
  clientCache.clear();
  inFlight.clear();
}

function buildClient(kc: k8s.KubeConfig, cluster: ClusterEntry, expiresAt: number): CachedClient {
  return {
    kubeConfig: kc,
    cluster,
    coreV1Api: kc.makeApiClient(k8s.CoreV1Api),
    appsV1Api: kc.makeApiClient(k8s.AppsV1Api),
    authorizationV1Api: kc.makeApiClient(k8s.AuthorizationV1Api),
    autoscalingV2Api: kc.makeApiClient(k8s.AutoscalingV2Api),
    batchV1Api: kc.makeApiClient(k8s.BatchV1Api),
    networkingV1Api: kc.makeApiClient(k8s.NetworkingV1Api),
    customObjectsApi: kc.makeApiClient(k8s.CustomObjectsApi),
    versionApi: kc.makeApiClient(k8s.VersionApi),
    apisApi: kc.makeApiClient(k8s.ApisApi),
    expiresAt,
  };
}

/**
 * Returns Kubernetes API clients for the given cluster name ("default" or empty selects the default cluster).
 * Unknown cluster names are rejected; clusters come from the registry (see clusters/registry.ts).
 */
export async function getK8sClientForCluster(clusterName: string = "default"): Promise<CachedClient> {
  const reg = getClusterRegistry();
  const entry = await reg.resolve(clusterName);

  const cached = clientCache.get(entry.name);
  if (cached && cached.expiresAt > Date.now()) return cached;

  // Concurrent calls for the same cluster share one credential fetch
  let pending = inFlight.get(entry.name);
  if (!pending) {
    pending = reg.getKubeConfig(entry.name)
      .then(({ kc, expiresAt }) => {
        const client = buildClient(kc, entry, expiresAt);
        clientCache.set(entry.name, client);
        return client;
      })
      .finally(() => inFlight.delete(entry.name));
    inFlight.set(entry.name, pending);
  }
  return pending;
}

/** Lists registered clusters. */
export async function listRegisteredClusters(): Promise<ClusterEntry[]> {
  return getClusterRegistry().list();
}
