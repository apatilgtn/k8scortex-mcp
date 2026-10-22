import type { KubeConfig } from "@kubernetes/client-node";

export type ProviderId = "kubeconfig" | "azure-keyvault" | "eks" | "gke";

export type CloudId = "aks" | "eks" | "gke" | "openshift" | "local" | "unknown" | (string & {});

/** A registered cluster. Provider-specific fields are optional and only read by the matching provider. */
export interface ClusterEntry {
  name: string;
  provider: ProviderId;
  cloud: CloudId;
  region?: string;
  labels?: Record<string, string>;

  // kubeconfig
  context?: string;
  kubeconfigPath?: string;

  // azure-keyvault
  keyVaultUri?: string;
  secretName?: string;

  // eks
  eksClusterName?: string;
  roleArn?: string;

  // gke
  project?: string;
  location?: string;
  gkeClusterName?: string;
  usePrivateEndpoint?: boolean;
}

/** A per-cluster restriction layered on top of the global tool → role table. Policies only ever tighten access. */
export interface ClusterPolicy {
  /** Glob on the cluster name, e.g. "prod-*". */
  match?: string;
  /** All of these labels must be present on the cluster entry. */
  labels?: Record<string, string>;
  /** Minimum role required on matching clusters. */
  minRole?: string;
  /** Which tools minRole applies to (default "all"). */
  appliesTo?: "all" | "mutating";
  /** Tools that nobody may invoke on matching clusters. */
  denyTools?: string[];
}

export interface ResolvedKubeConfig {
  kc: KubeConfig;
  /** Epoch millis after which credentials must be re-resolved. */
  expiresAt: number;
}

export interface ClusterProvider {
  id: ProviderId;
  /** Lists clusters this provider discovers on its own (providers configured purely from the registry file return []). */
  list(): Promise<ClusterEntry[]>;
  getKubeConfig(entry: ClusterEntry): Promise<ResolvedKubeConfig>;
}

/** Builds a single-context KubeConfig from an API endpoint, CA bundle and bearer token. */
export function kubeConfigFromToken(
  KubeConfigCtor: typeof KubeConfig,
  name: string,
  server: string,
  caData: string | undefined,
  token: string
): KubeConfig {
  const kc = new KubeConfigCtor();
  kc.loadFromOptions({
    clusters: [{ name, server, caData, skipTLSVerify: false }],
    users: [{ name, token }],
    contexts: [{ name, cluster: name, user: name }],
    currentContext: name,
  });
  return kc;
}

/** Imports an optional cloud SDK, explaining how to install it when missing. */
export async function importOptional<T>(specifier: string, provider: ProviderId): Promise<T> {
  try {
    return await import(specifier) as T;
  } catch (err: any) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
      throw new Error(`The '${provider}' cluster provider requires the optional package '${specifier}'. Install it with: npm install ${specifier}`);
    }
    throw err;
  }
}
