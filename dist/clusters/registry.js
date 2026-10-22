import { readFileSync } from "fs";
import { isKnownRole } from "../roles.js";
import { createKubeconfigProvider } from "./kubeconfig.js";
import { createAzureKeyVaultProvider } from "./azure-keyvault.js";
import { createEksProvider } from "./eks.js";
import { createGkeProvider } from "./gke.js";
const PROVIDER_IDS = ["kubeconfig", "azure-keyvault", "eks", "gke"];
// The cluster list is re-read at most this often (Key Vault index, kubeconfig file, or registry file)
const LIST_TTL_MS = 30_000;
export function createClusterRegistry(opts) {
    let listCache;
    async function list() {
        if (listCache && listCache.expiresAt > Date.now())
            return listCache.entries;
        const entries = await opts.discover();
        listCache = { entries, expiresAt: Date.now() + LIST_TTL_MS };
        return entries;
    }
    async function resolve(name) {
        const entries = await list();
        const known = () => entries.map(e => e.name).join(", ") || "(none)";
        let target = name;
        if (!target || target === "default") {
            target = opts.defaultCluster?.()
                ?? (entries.some(e => e.name === "default") ? "default" : undefined)
                ?? (entries.length === 1 ? entries[0].name : undefined);
            if (!target)
                throw new Error(`No default cluster is configured. Specify 'cluster' as one of: ${known()}`);
        }
        const entry = entries.find(e => e.name === target);
        if (!entry)
            throw new Error(`Unknown cluster '${target}'. Known clusters: ${known()}`);
        return entry;
    }
    async function getKubeConfig(name) {
        const entry = await resolve(name);
        const provider = opts.providers[entry.provider];
        if (!provider)
            throw new Error(`Cluster '${entry.name}' uses provider '${entry.provider}', which is not enabled`);
        return { entry, ...(await provider.getKubeConfig(entry)) };
    }
    return { list, resolve, getKubeConfig, policies: opts.policies ?? [] };
}
/** Parses and validates a cluster registry file (CLUSTERS_CONFIG). */
export function parseRegistryFile(raw, source = "CLUSTERS_CONFIG") {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.clusters))
        throw new Error(`${source} must contain a 'clusters' array`);
    const seen = new Set();
    parsed.clusters = parsed.clusters.map((c, i) => {
        if (!c?.name || typeof c.name !== "string")
            throw new Error(`${source}: clusters[${i}] is missing 'name'`);
        if (seen.has(c.name))
            throw new Error(`${source}: duplicate cluster name '${c.name}'`);
        seen.add(c.name);
        const provider = c.provider || "kubeconfig";
        if (!PROVIDER_IDS.includes(provider)) {
            throw new Error(`${source}: cluster '${c.name}' has unknown provider '${provider}' (expected one of ${PROVIDER_IDS.join(", ")})`);
        }
        const defaultCloud = provider === "eks" ? "eks" : provider === "gke" ? "gke" : "unknown";
        return { ...c, provider, cloud: c.cloud || defaultCloud };
    });
    if (parsed.defaultCluster && !seen.has(parsed.defaultCluster)) {
        throw new Error(`${source}: defaultCluster '${parsed.defaultCluster}' is not a registered cluster`);
    }
    if (parsed.policies !== undefined && !Array.isArray(parsed.policies))
        throw new Error(`${source}: 'policies' must be an array`);
    for (const [i, policy] of (parsed.policies ?? []).entries()) {
        if (policy.minRole !== undefined && !isKnownRole(policy.minRole))
            throw new Error(`${source}: policies[${i}] has unknown minRole '${policy.minRole}'`);
        if (policy.appliesTo !== undefined && !["all", "mutating"].includes(policy.appliesTo))
            throw new Error(`${source}: policies[${i}].appliesTo must be 'all' or 'mutating'`);
        if (policy.denyTools !== undefined && !Array.isArray(policy.denyTools))
            throw new Error(`${source}: policies[${i}].denyTools must be an array`);
    }
    return parsed;
}
/**
 * Builds the registry from the environment:
 * - CLUSTERS_CONFIG: a JSON file listing clusters across providers (plus optional policies)
 * - USE_LOCAL_KUBECONFIG=true: kubeconfig contexts, even when Key Vault is configured
 * - AZURE_KEYVAULT_URI: the Key Vault cluster index
 * - otherwise: kubeconfig contexts (or the in-cluster service account)
 * DEFAULT_CLUSTER overrides which cluster is used when a tool call names none.
 */
export function createRegistryFromEnv(env = process.env) {
    const kubeconfig = createKubeconfigProvider();
    const keyVault = createAzureKeyVaultProvider({
        keyVaultUri: env.AZURE_KEYVAULT_URI || "",
        secretPrefix: env.KUBECONFIG_SECRET_PREFIX || "kubeconfig-",
        registrySecret: env.CLUSTER_REGISTRY_SECRET || "kubenexus-cluster-index",
    });
    if (env.CLUSTERS_CONFIG) {
        const file = parseRegistryFile(readFileSync(env.CLUSTERS_CONFIG, "utf-8"));
        return createClusterRegistry({
            discover: async () => file.clusters,
            providers: { kubeconfig, "azure-keyvault": keyVault, eks: createEksProvider(), gke: createGkeProvider() },
            defaultCluster: () => env.DEFAULT_CLUSTER || file.defaultCluster,
            policies: file.policies,
        });
    }
    if (env.AZURE_KEYVAULT_URI && env.USE_LOCAL_KUBECONFIG !== "true") {
        return createClusterRegistry({
            discover: () => keyVault.list(),
            providers: { "azure-keyvault": keyVault },
            defaultCluster: () => env.DEFAULT_CLUSTER || undefined,
        });
    }
    return createClusterRegistry({
        discover: () => kubeconfig.list(),
        providers: { kubeconfig },
        defaultCluster: () => env.DEFAULT_CLUSTER || kubeconfig.currentContext() || undefined,
    });
}
