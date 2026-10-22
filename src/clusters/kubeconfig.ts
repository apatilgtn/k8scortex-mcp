import * as k8s from "@kubernetes/client-node";
import { ClusterEntry, ClusterProvider, CloudId, ResolvedKubeConfig } from "./types.js";

// Kubeconfig files can change (new contexts, refreshed tokens), so clients are rebuilt periodically
const KUBECONFIG_TTL_MS = 5 * 60 * 1000;

/** Guesses the hosting platform of a cluster from its API server URL and context name. */
export function guessCloud(server: string | undefined, contextName: string): CloudId {
  let host = "";
  try { host = new URL(server || "").hostname; } catch { /* unparseable server URL */ }
  if (host.endsWith(".eks.amazonaws.com") || contextName.startsWith("arn:aws:eks:")) return "eks";
  if (host.endsWith(".azmk8s.io")) return "aks";
  if (host.endsWith(".gke.goog") || contextName.startsWith("gke_")) return "gke";
  if (host.endsWith(".openshiftapps.com") || (host.startsWith("api.") && server?.endsWith(":6443"))) return "openshift";
  if (contextName === "minikube" || contextName.startsWith("kind-") || contextName === "docker-desktop"
    || contextName.startsWith("k3d-") || host === "localhost" || host === "127.0.0.1") return "local";
  return "unknown";
}

function loadKubeConfig(path?: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (path) kc.loadFromFile(path);
  else kc.loadFromDefault();
  return kc;
}

/**
 * Exposes every context in the local kubeconfig (KUBECONFIG or ~/.kube/config, or the in-cluster
 * service account) as a cluster. Exec credential plugins such as aws-iam-authenticator and
 * gke-gcloud-auth-plugin are handled by the Kubernetes client.
 */
export function createKubeconfigProvider(load: (path?: string) => k8s.KubeConfig = loadKubeConfig): ClusterProvider & {
  currentContext(): string;
} {
  return {
    id: "kubeconfig",

    currentContext() {
      return load().getCurrentContext();
    },

    async list(): Promise<ClusterEntry[]> {
      const kc = load();
      return kc.getContexts().map((ctx) => ({
        name: ctx.name,
        provider: "kubeconfig",
        cloud: guessCloud(kc.getCluster(ctx.cluster)?.server, ctx.name),
        context: ctx.name,
      }));
    },

    async getKubeConfig(entry: ClusterEntry): Promise<ResolvedKubeConfig> {
      const source = load(entry.kubeconfigPath);
      const contextName = entry.context || entry.name;
      if (!source.getContextObject(contextName)) {
        throw new Error(`Context '${contextName}' not found in kubeconfig`);
      }
      const kc = new k8s.KubeConfig();
      kc.loadFromOptions({
        clusters: source.getClusters(),
        users: source.getUsers(),
        contexts: source.getContexts(),
        currentContext: contextName,
      });
      return { kc, expiresAt: Date.now() + KUBECONFIG_TTL_MS };
    },
  };
}
