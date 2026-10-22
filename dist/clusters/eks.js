import * as k8s from "@kubernetes/client-node";
import { importOptional, kubeConfigFromToken } from "./types.js";
// EKS accepts a token for 15 minutes after signing; refresh a minute early
const EKS_TOKEN_TTL_MS = 14 * 60 * 1000;
function encodeQuery(query) {
    return Object.entries(query)
        .flatMap(([k, v]) => (Array.isArray(v) ? v : [v ?? ""]).map(item => `${encodeURIComponent(k)}=${encodeURIComponent(item)}`))
        .join("&");
}
/**
 * Creates a bearer token for an EKS cluster, equivalent to `aws eks get-token`: a presigned
 * STS GetCallerIdentity URL bound to the cluster name through the x-k8s-aws-id header.
 */
export async function createEksToken(clusterName, region, credentials) {
    const { SignatureV4 } = await importOptional("@smithy/signature-v4", "eks");
    const { Sha256 } = await importOptional("@aws-crypto/sha256-js", "eks");
    const hostname = `sts.${region}.amazonaws.com`;
    const signer = new SignatureV4({ credentials, region, service: "sts", sha256: Sha256 });
    const presigned = await signer.presign({
        method: "GET",
        protocol: "https:",
        hostname,
        path: "/",
        query: { Action: "GetCallerIdentity", Version: "2011-06-15" },
        headers: { host: hostname, "x-k8s-aws-id": clusterName },
    }, { expiresIn: 60 });
    const url = `https://${hostname}/?${encodeQuery(presigned.query)}`;
    return `k8s-aws-v1.${Buffer.from(url).toString("base64url")}`;
}
const defaultDeps = {
    async getCredentials(entry, region) {
        const providers = await importOptional("@aws-sdk/credential-providers", "eks");
        const provider = entry.roleArn
            ? providers.fromTemporaryCredentials({
                params: { RoleArn: entry.roleArn, RoleSessionName: "k8scortex-mcp" },
                clientConfig: { region },
            })
            : providers.fromNodeProviderChain();
        return provider();
    },
    async describeCluster(name, region, credentials) {
        const { EKSClient, DescribeClusterCommand } = await importOptional("@aws-sdk/client-eks", "eks");
        const client = new EKSClient({ region, credentials });
        const { cluster } = await client.send(new DescribeClusterCommand({ name }));
        if (!cluster?.endpoint)
            throw new Error(`EKS cluster '${name}' in ${region} has no API endpoint`);
        return { endpoint: cluster.endpoint, caData: cluster.certificateAuthority?.data };
    },
};
/**
 * Connects to EKS clusters with short-lived IAM tokens. Credentials come from the default AWS chain
 * (IRSA, EKS Pod Identity, instance profile, env vars, SSO), optionally assuming entry.roleArn.
 */
export function createEksProvider(deps = defaultDeps) {
    return {
        id: "eks",
        async list() {
            return [];
        },
        async getKubeConfig(entry) {
            const region = entry.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
            if (!region)
                throw new Error(`EKS cluster '${entry.name}' needs a region (set 'region' in the cluster registry or AWS_REGION)`);
            const clusterName = entry.eksClusterName || entry.name;
            const credentials = await deps.getCredentials(entry, region);
            const { endpoint, caData } = await deps.describeCluster(clusterName, region, credentials);
            const token = await createEksToken(clusterName, region, credentials);
            // Never cache past the underlying credentials' own expiry
            const credentialExpiry = credentials.expiration ? credentials.expiration.getTime() - 60_000 : Infinity;
            return {
                kc: kubeConfigFromToken(k8s.KubeConfig, entry.name, endpoint, caData, token),
                expiresAt: Math.min(Date.now() + EKS_TOKEN_TTL_MS, credentialExpiry),
            };
        },
    };
}
