import * as k8s from "@kubernetes/client-node";
// Kubeconfigs in Key Vault may be rotated, so they are re-fetched after this interval
const KEYVAULT_TTL_MS = 5 * 60 * 1000;
// Key Vault secret names only allow alphanumerics and dashes
const SECRET_NAME_PATTERN = /^[0-9a-zA-Z-]{1,127}$/;
/**
 * Fetches an Azure Key Vault secret using Workload Identity (federated token from the pod env).
 * In production, AZURE_CLIENT_ID is auto-injected by the AKS Workload Identity webhook.
 */
export async function fetchKeyVaultSecret(keyVaultUri, secretName) {
    if (!keyVaultUri) {
        throw new Error("AZURE_KEYVAULT_URI environment variable is not set.");
    }
    if (!SECRET_NAME_PATTERN.test(secretName)) {
        throw new Error(`Invalid Key Vault secret name '${secretName}'`);
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
    const secretUrl = `${keyVaultUri.replace(/\/$/, "")}/secrets/${secretName}?api-version=7.4`;
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
 * Reads the cluster index and base64-encoded kubeconfigs from Azure Key Vault.
 * The index secret holds a JSON array of { name, cloud, region } objects; each cluster's kubeconfig
 * lives in a secret named <secretPrefix><cluster name>.
 */
export function createAzureKeyVaultProvider(options) {
    return {
        id: "azure-keyvault",
        async list() {
            const raw = await fetchKeyVaultSecret(options.keyVaultUri, options.registrySecret);
            const entries = JSON.parse(raw);
            return entries.map((e) => ({ ...e, provider: "azure-keyvault", cloud: e.cloud || "unknown" }));
        },
        async getKubeConfig(entry) {
            const secretName = entry.secretName || `${options.secretPrefix}${entry.name}`;
            const b64kubeconfig = await fetchKeyVaultSecret(entry.keyVaultUri || options.keyVaultUri, secretName);
            const kc = new k8s.KubeConfig();
            kc.loadFromString(Buffer.from(b64kubeconfig, "base64").toString("utf-8"));
            return { kc, expiresAt: Date.now() + KEYVAULT_TTL_MS };
        },
    };
}
