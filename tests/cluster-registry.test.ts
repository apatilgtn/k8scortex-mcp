import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as k8s from "@kubernetes/client-node";
import { createKubeconfigProvider, guessCloud } from "../src/clusters/kubeconfig.js";
import { createClusterRegistry, parseRegistryFile } from "../src/clusters/registry.js";
import { createEksProvider, createEksToken } from "../src/clusters/eks.js";
import { createGkeProvider } from "../src/clusters/gke.js";
import { ClusterEntry, ClusterProvider } from "../src/clusters/types.js";
import { getK8sClientForCluster, setClusterRegistry } from "../src/cluster-store.js";
import { filterClusters, parseLabelSelector } from "../src/tools/multicluster.js";

const KUBECONFIG_YAML = `
apiVersion: v1
kind: Config
current-context: minikube
clusters:
- name: eks-prod
  cluster: { server: "https://ABC123.gr7.us-east-1.eks.amazonaws.com" }
- name: aks-dev
  cluster: { server: "https://aks-dev-dns-1234.hcp.westeurope.azmk8s.io:443" }
- name: minikube
  cluster: { server: "https://192.168.49.2:8443" }
users:
- name: u1
  user: { token: "t1" }
contexts:
- name: arn:aws:eks:us-east-1:111122223333:cluster/prod
  context: { cluster: eks-prod, user: u1 }
- name: aks-dev
  context: { cluster: aks-dev, user: u1 }
- name: minikube
  context: { cluster: minikube, user: u1 }
`;

function writeKubeconfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "k8scortex-"));
  const path = join(dir, "config");
  writeFileSync(path, KUBECONFIG_YAML);
  return path;
}

function fileProvider(path: string) {
  return createKubeconfigProvider(() => {
    const kc = new k8s.KubeConfig();
    kc.loadFromFile(path);
    return kc;
  });
}

const entry = (name: string, extra: Partial<ClusterEntry> = {}): ClusterEntry => ({ name, provider: "kubeconfig", cloud: "unknown", ...extra });

describe("kubeconfig provider", () => {
  it("lists every context as a cluster and guesses its cloud", async () => {
    const provider = fileProvider(writeKubeconfig());
    const clusters = await provider.list();
    expect(clusters.map(c => [c.name, c.cloud])).toEqual([
      ["arn:aws:eks:us-east-1:111122223333:cluster/prod", "eks"],
      ["aks-dev", "aks"],
      ["minikube", "local"],
    ]);
    expect(provider.currentContext()).toBe("minikube");
  });

  it("returns a kubeconfig switched to the requested context", async () => {
    const provider = fileProvider(writeKubeconfig());
    const { kc } = await provider.getKubeConfig(entry("aks-dev"));
    expect(kc.getCurrentContext()).toBe("aks-dev");
    expect(kc.getCurrentCluster()?.server).toContain("azmk8s.io");
  });

  it("rejects contexts that do not exist", async () => {
    await expect(fileProvider(writeKubeconfig()).getKubeConfig(entry("nope"))).rejects.toThrow(/not found/);
  });

  it("guesses other platforms", () => {
    expect(guessCloud("https://34.1.2.3", "gke_proj_us-central1_prod")).toBe("gke");
    expect(guessCloud("https://api.ocp.example.com:6443", "admin")).toBe("openshift");
    expect(guessCloud("https://127.0.0.1:6443", "kind-dev")).toBe("local");
    expect(guessCloud("https://k8s.example.com", "corp")).toBe("unknown");
  });
});

describe("cluster registry", () => {
  const twoClusters = async () => [entry("dev"), entry("prod")];
  const noopProvider: ClusterProvider = { id: "kubeconfig", list: async () => [], getKubeConfig: async () => ({ kc: new k8s.KubeConfig(), expiresAt: Date.now() + 60_000 }) };

  it("resolves 'default' to the configured default cluster", async () => {
    const reg = createClusterRegistry({ discover: twoClusters, providers: { kubeconfig: noopProvider }, defaultCluster: () => "prod" });
    expect((await reg.resolve("default")).name).toBe("prod");
    expect((await reg.resolve(undefined)).name).toBe("prod");
  });

  it("uses the only cluster when there is no explicit default", async () => {
    const reg = createClusterRegistry({ discover: async () => [entry("solo")], providers: {} });
    expect((await reg.resolve("default")).name).toBe("solo");
  });

  it("requires an explicit cluster when several exist and none is the default", async () => {
    const reg = createClusterRegistry({ discover: twoClusters, providers: {} });
    await expect(reg.resolve("default")).rejects.toThrow(/No default cluster.*dev, prod/);
  });

  it("rejects unknown cluster names, including path-like input", async () => {
    const reg = createClusterRegistry({ discover: twoClusters, providers: {} });
    await expect(reg.resolve("../secrets/other")).rejects.toThrow(/Unknown cluster/);
  });

  it("errors when a cluster's provider is not enabled", async () => {
    const reg = createClusterRegistry({ discover: async () => [entry("x", { provider: "eks" })], providers: {} });
    await expect(reg.getKubeConfig("x")).rejects.toThrow(/provider 'eks'/);
  });
});

describe("registry file", () => {
  it("defaults the provider to kubeconfig and the cloud from the provider", () => {
    const file = parseRegistryFile(JSON.stringify({
      defaultCluster: "a",
      clusters: [{ name: "a" }, { name: "b", provider: "eks", region: "us-east-1" }],
    }));
    expect(file.clusters[0]).toMatchObject({ provider: "kubeconfig", cloud: "unknown" });
    expect(file.clusters[1]).toMatchObject({ provider: "eks", cloud: "eks" });
  });

  it.each([
    [{ clusters: [{ name: "a" }, { name: "a" }] }, /duplicate/],
    [{ clusters: [{ name: "a", provider: "rancher" }] }, /unknown provider/],
    [{ defaultCluster: "z", clusters: [{ name: "a" }] }, /defaultCluster 'z'/],
    [{}, /'clusters' array/],
    [{ clusters: [{ name: "a" }], policies: [{ match: "*", minRole: "admin" }] }, /unknown minRole/],
    [{ clusters: [{ name: "a" }], policies: [{ match: "*", appliesTo: "writes" }] }, /appliesTo/],
  ])("rejects invalid files (%#)", (content, error) => {
    expect(() => parseRegistryFile(JSON.stringify(content))).toThrow(error);
  });
});

describe("client cache", () => {
  afterEach(() => setClusterRegistry(undefined));

  function countingRegistry(ttlMs: number) {
    let calls = 0;
    const provider: ClusterProvider = {
      id: "kubeconfig",
      list: async () => [],
      getKubeConfig: async (e) => {
        calls++;
        await new Promise(r => setTimeout(r, 10));
        const kc = new k8s.KubeConfig();
        kc.loadFromOptions({ clusters: [{ name: e.name, server: "https://example" }], users: [{ name: "u" }], contexts: [{ name: e.name, cluster: e.name, user: "u" }], currentContext: e.name });
        return { kc, expiresAt: Date.now() + ttlMs };
      },
    };
    setClusterRegistry(createClusterRegistry({ discover: async () => [entry("a")], providers: { kubeconfig: provider } }));
    return () => calls;
  }

  it("shares one credential fetch between concurrent calls and caches the result", async () => {
    const calls = countingRegistry(60_000);
    const [c1, c2] = await Promise.all([getK8sClientForCluster("a"), getK8sClientForCluster("default")]);
    expect(c1).toBe(c2);
    await getK8sClientForCluster("a");
    expect(calls()).toBe(1);
    expect(c1.cluster.name).toBe("a");
  });

  it("refetches credentials after they expire", async () => {
    const calls = countingRegistry(-1);
    await getK8sClientForCluster("a");
    await getK8sClientForCluster("a");
    expect(calls()).toBe(2);
  });
});

describe("EKS provider", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "session", expiration: new Date(Date.now() + 5 * 60_000) };

  it("creates a presigned STS token bound to the cluster", async () => {
    const token = await createEksToken("prod", "us-east-1", credentials);
    expect(token.startsWith("k8s-aws-v1.")).toBe(true);
    const url = new URL(Buffer.from(token.slice("k8s-aws-v1.".length), "base64url").toString());
    expect(url.hostname).toBe("sts.us-east-1.amazonaws.com");
    expect(url.searchParams.get("Action")).toBe("GetCallerIdentity");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("x-k8s-aws-id");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("session");
  });

  it("builds a kubeconfig from DescribeCluster and never outlives the credentials", async () => {
    const seen: string[] = [];
    const provider = createEksProvider({
      getCredentials: async (e, region) => { seen.push(`${e.roleArn}@${region}`); return credentials; },
      describeCluster: async (name, region) => { seen.push(`${name}@${region}`); return { endpoint: "https://ABC.eks.amazonaws.com", caData: "Q0E=" }; },
    });
    const { kc, expiresAt } = await provider.getKubeConfig(entry("prod-eks", { provider: "eks", region: "eu-west-1", eksClusterName: "prod", roleArn: "arn:aws:iam::1:role/r" }));
    expect(seen).toEqual(["arn:aws:iam::1:role/r@eu-west-1", "prod@eu-west-1"]);
    expect(kc.getCurrentCluster()?.server).toBe("https://ABC.eks.amazonaws.com");
    expect(kc.getCurrentCluster()?.caData).toBe("Q0E=");
    expect(kc.getCurrentUser()?.token).toMatch(/^k8s-aws-v1\./);
    expect(expiresAt).toBeLessThanOrEqual(credentials.expiration.getTime() - 60_000);
  });

  it("requires a region", async () => {
    const env = { AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION; delete process.env.AWS_DEFAULT_REGION;
    try {
      const provider = createEksProvider({ getCredentials: async () => credentials, describeCluster: async () => ({ endpoint: "https://x" }) });
      await expect(provider.getKubeConfig(entry("p", { provider: "eks" }))).rejects.toThrow(/region/);
    } finally {
      Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
    }
  });
});

describe("GKE provider", () => {
  function mockClient(cluster: object, expiry = Date.now() + 30 * 60_000) {
    const urls: string[] = [];
    return {
      urls,
      deps: {
        getClient: async () => ({
          credentials: { expiry_date: expiry },
          getAccessToken: async () => ({ token: "ya29.token" }),
          request: async <T>({ url }: { url: string }) => { urls.push(url); return { data: cluster as T }; },
        }),
      },
    };
  }

  it("builds a kubeconfig from the GKE API using the access token", async () => {
    const expiry = Date.now() + 30 * 60_000;
    const mock = mockClient({ endpoint: "34.1.2.3", masterAuth: { clusterCaCertificate: "Q0E=" } }, expiry);
    const { kc, expiresAt } = await createGkeProvider(mock.deps).getKubeConfig(
      entry("prod-gke", { provider: "gke", project: "my-proj", location: "us-central1", gkeClusterName: "prod" })
    );
    expect(mock.urls).toEqual(["https://container.googleapis.com/v1/projects/my-proj/locations/us-central1/clusters/prod"]);
    expect(kc.getCurrentCluster()?.server).toBe("https://34.1.2.3");
    expect(kc.getCurrentUser()?.token).toBe("ya29.token");
    expect(expiresAt).toBe(expiry - 60_000);
  });

  it("can use the private endpoint", async () => {
    const mock = mockClient({ endpoint: "34.1.2.3", privateClusterConfig: { privateEndpoint: "10.0.0.2" } });
    const { kc } = await createGkeProvider(mock.deps).getKubeConfig(
      entry("p", { provider: "gke", project: "p", location: "europe-west1-b", usePrivateEndpoint: true })
    );
    expect(kc.getCurrentCluster()?.server).toBe("https://10.0.0.2");
  });

  it("requires project and location", async () => {
    const env = process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    try {
      await expect(createGkeProvider(mockClient({}).deps).getKubeConfig(entry("p", { provider: "gke" }))).rejects.toThrow(/project/);
    } finally {
      if (env !== undefined) process.env.GOOGLE_CLOUD_PROJECT = env;
    }
  });
});

describe("list_clusters filters", () => {
  const clusters = [
    entry("a", { cloud: "eks", region: "us-east-1", labels: { env: "prod" } }),
    entry("b", { cloud: "gke", region: "us-central1", labels: { env: "dev" } }),
  ];

  it("filters by cloud, region and labels", () => {
    expect(filterClusters(clusters, { cloud: "eks" }).map(c => c.name)).toEqual(["a"]);
    expect(filterClusters(clusters, { region: "us-central1" }).map(c => c.name)).toEqual(["b"]);
    expect(filterClusters(clusters, { labelSelector: "env=prod" }).map(c => c.name)).toEqual(["a"]);
  });

  it("rejects malformed label selectors", () => {
    expect(() => parseLabelSelector("env")).toThrow(/key=value/);
  });
});
