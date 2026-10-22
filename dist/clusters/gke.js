import * as k8s from "@kubernetes/client-node";
import { importOptional, kubeConfigFromToken } from "./types.js";
// Access tokens are refreshed a minute before Google reports they expire
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 50 * 60 * 1000;
const defaultDeps = {
    async getClient() {
        const { GoogleAuth } = await importOptional("google-auth-library", "gke");
        const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        return await auth.getClient();
    },
};
/**
 * Connects to GKE clusters using Application Default Credentials (GKE Workload Identity,
 * a service account key, or gcloud user credentials) as the bearer token.
 */
export function createGkeProvider(deps = defaultDeps) {
    let clientPromise;
    const getClient = () => {
        clientPromise ??= deps.getClient();
        clientPromise.catch(() => { clientPromise = undefined; });
        return clientPromise;
    };
    return {
        id: "gke",
        async list() {
            return [];
        },
        async getKubeConfig(entry) {
            const project = entry.project || process.env.GOOGLE_CLOUD_PROJECT;
            const location = entry.location || entry.region;
            if (!project || !location) {
                throw new Error(`GKE cluster '${entry.name}' needs 'project' and 'location' (region or zone) in the cluster registry`);
            }
            const clusterName = entry.gkeClusterName || entry.name;
            const client = await getClient();
            const url = `https://container.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/clusters/${encodeURIComponent(clusterName)}`;
            const { data: cluster } = await client.request({ url });
            const host = entry.usePrivateEndpoint ? cluster.privateClusterConfig?.privateEndpoint : cluster.endpoint;
            if (!host)
                throw new Error(`GKE cluster '${clusterName}' has no ${entry.usePrivateEndpoint ? "private " : ""}endpoint`);
            const { token } = await client.getAccessToken();
            if (!token)
                throw new Error("Google credentials did not return an access token");
            const expiry = client.credentials?.expiry_date ?? Date.now() + DEFAULT_TOKEN_TTL_MS;
            return {
                kc: kubeConfigFromToken(k8s.KubeConfig, entry.name, `https://${host}`, cluster.masterAuth?.clusterCaCertificate, token),
                expiresAt: expiry - EXPIRY_MARGIN_MS,
            };
        },
    };
}
