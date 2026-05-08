import * as k8s from "@kubernetes/client-node";
// In-memory TTL cache: clusterName -> client + expiry
const clientCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const KEYVAULT_URI = process.env.AZURE_KEYVAULT_URI || "";
const KUBECONFIG_SECRET_PREFIX = process.env.KUBECONFIG_SECRET_PREFIX || "kubeconfig-";
const CLUSTER_REGISTRY_SECRET = process.env.CLUSTER_REGISTRY_SECRET || "kubenexus-cluster-index";
/**
 * Returns a local client using the machine's default kubeconfig.
 * Used in local dev mode (DISABLE_AUTH=true).
 */
function buildLocalClient() {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    return {
        coreV1Api: kc.makeApiClient(k8s.CoreV1Api),
        appsV1Api: kc.makeApiClient(k8s.AppsV1Api),
        authorizationV1Api: kc.makeApiClient(k8s.AuthorizationV1Api),
        autoscalingV2Api: kc.makeApiClient(k8s.AutoscalingV2Api),
        batchV1Api: kc.makeApiClient(k8s.BatchV1Api),
        networkingV1Api: kc.makeApiClient(k8s.NetworkingV1Api),
        customObjectsApi: kc.makeApiClient(k8s.CustomObjectsApi),
        expiresAt: Date.now() + CACHE_TTL_MS,
    };
}
/**
 * Fetches an Azure Key Vault secret using Workload Identity (federated token from the pod env).
 * In production, AZURE_CLIENT_ID is auto-injected by the AKS Workload Identity webhook.
 */
async function fetchKeyVaultSecret(secretName) {
    if (!KEYVAULT_URI) {
        throw new Error("AZURE_KEYVAULT_URI environment variable is not set.");
    }
    // Fetch managed identity token
    const tokenEndpoint = process.env.IDENTITY_ENDPOINT || "http://169.254.169.254/metadata/identity/oauth2/token";
    const tokenParams = new URLSearchParams({
        resource: "https://vault.azure.net",
        "api-version": "2018-02-01",
    });
    const tokenRes = await fetch(`${tokenEndpoint}?${tokenParams}`, {
        headers: { Metadata: "true" },
    });
    if (!tokenRes.ok) {
        throw new Error(`Failed to get identity token: ${tokenRes.statusText}`);
    }
    const { access_token } = await tokenRes.json();
    // Fetch the secret from Key Vault
    const secretUrl = `${KEYVAULT_URI}/secrets/${secretName}?api-version=7.4`;
    const secretRes = await fetch(secretUrl, {
        headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!secretRes.ok) {
        const body = await secretRes.text();
        throw new Error(`Key Vault fetch failed for secret '${secretName}': ${secretRes.status} ${body}`);
    }
    const { value } = await secretRes.json();
    return value;
}
/**
 * Builds a KubeConfig from a base64-encoded kubeconfig string stored in Key Vault.
 */
function buildClientFromBase64Kubeconfig(b64kubeconfig) {
    const yaml = Buffer.from(b64kubeconfig, "base64").toString("utf-8");
    const kc = new k8s.KubeConfig();
    kc.loadFromString(yaml);
    return {
        coreV1Api: kc.makeApiClient(k8s.CoreV1Api),
        appsV1Api: kc.makeApiClient(k8s.AppsV1Api),
        authorizationV1Api: kc.makeApiClient(k8s.AuthorizationV1Api),
        autoscalingV2Api: kc.makeApiClient(k8s.AutoscalingV2Api),
        batchV1Api: kc.makeApiClient(k8s.BatchV1Api),
        networkingV1Api: kc.makeApiClient(k8s.NetworkingV1Api),
        customObjectsApi: kc.makeApiClient(k8s.CustomObjectsApi),
        expiresAt: Date.now() + CACHE_TTL_MS,
    };
}
/**
 * Returns Kubernetes API clients for the given cluster name.
 * - Local dev (DISABLE_AUTH=true): always uses default kubeconfig, ignores clusterName
 * - Production: fetches kubeconfig from Azure Key Vault with 5-minute TTL cache
 */
export async function getK8sClientForCluster(clusterName = "default") {
    // Local dev bypass — also honoured when USE_LOCAL_KUBECONFIG=true (e.g. auth integration tests)
    if (process.env.DISABLE_AUTH === "true" || process.env.USE_LOCAL_KUBECONFIG === "true") {
        const cached = clientCache.get("__local__");
        if (cached && cached.expiresAt > Date.now())
            return cached;
        const client = buildLocalClient();
        clientCache.set("__local__", client);
        return client;
    }
    // Check TTL cache
    const cached = clientCache.get(clusterName);
    if (cached && cached.expiresAt > Date.now()) {
        return cached;
    }
    // Fetch kubeconfig from Key Vault
    const secretName = `${KUBECONFIG_SECRET_PREFIX}${clusterName}`;
    const b64kubeconfig = await fetchKeyVaultSecret(secretName);
    const client = buildClientFromBase64Kubeconfig(b64kubeconfig);
    clientCache.set(clusterName, client);
    return client;
}
/**
 * Fetches the list of registered clusters from Key Vault.
 * Falls back to ["default"] in local dev mode.
 */
export async function listRegisteredClusters() {
    if (process.env.DISABLE_AUTH === "true") {
        return [{ name: "default", cloud: "local", region: "local" }];
    }
    const raw = await fetchKeyVaultSecret(CLUSTER_REGISTRY_SECRET);
    return JSON.parse(raw);
}
