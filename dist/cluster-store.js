import * as k8s from "@kubernetes/client-node";
import { createRegistryFromEnv } from "./clusters/registry.js";
let registry;
// Client cache keyed by resolved cluster name; expiry follows each provider's credential lifetime
const clientCache = new Map();
const inFlight = new Map();
export function getClusterRegistry() {
    registry ??= createRegistryFromEnv();
    return registry;
}
/** Replaces the registry (tests) and clears cached clients. */
export function setClusterRegistry(next) {
    registry = next;
    clientCache.clear();
    inFlight.clear();
}
function buildClient(kc, cluster, expiresAt) {
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
export async function getK8sClientForCluster(clusterName = "default") {
    const reg = getClusterRegistry();
    const entry = await reg.resolve(clusterName);
    const cached = clientCache.get(entry.name);
    if (cached && cached.expiresAt > Date.now())
        return cached;
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
export async function listRegisteredClusters() {
    return getClusterRegistry().list();
}
