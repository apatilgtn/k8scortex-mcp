import { describe, expect, it, afterEach } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/server.js";
import { setClusterRegistry } from "../src/cluster-store.js";
import { createClusterRegistry } from "../src/clusters/registry.js";
import { ClusterEntry, ClusterProvider } from "../src/clusters/types.js";
import { UserContext } from "../src/context.js";

// A provider whose API server does not exist: any call that reaches Kubernetes fails with a connection error
const unreachable: ClusterProvider = {
  id: "kubeconfig",
  list: async () => [],
  getKubeConfig: async (e) => {
    const kc = new k8s.KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: e.name, server: "https://127.0.0.1:1" }],
      users: [{ name: "u", token: "t" }],
      contexts: [{ name: e.name, cluster: e.name, user: "u" }],
      currentContext: e.name,
    });
    return { kc, expiresAt: Date.now() + 60_000 };
  },
};

function useClusters(clusters: Array<Partial<ClusterEntry> & { name: string }>, extra: Partial<Parameters<typeof createClusterRegistry>[0]> = {}) {
  setClusterRegistry(createClusterRegistry({
    discover: async () => clusters.map(c => ({ provider: "kubeconfig", cloud: "unknown", ...c } as ClusterEntry)),
    providers: { kubeconfig: unreachable },
    defaultCluster: () => clusters[0]?.name,
    ...extra,
  }));
}

async function connect(user: UserContext | undefined) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(() => user).connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function callText(client: Client, name: string, args: object): Promise<string> {
  try {
    const result: any = await client.callTool({ name, arguments: args });
    return result.content?.[0]?.text ?? "";
  } catch (e: any) {
    return e.message;
  }
}

const admin: UserContext = { oid: "admin", roles: ["platform-engineer"] };

describe("MCP server", () => {
  afterEach(() => setClusterRegistry(undefined));

  it("denies every tool call without an authenticated user", async () => {
    useClusters([{ name: "dev" }]);
    const client = await connect(undefined);
    expect(await callText(client, "list_clusters", {})).toMatch(/Unauthorized/);
  });

  it("says which role a denied tool needs, so callers know who can do it", async () => {
    useClusters([{ name: "dev" }]);
    const client = await connect({ oid: "dev-user", roles: ["developer"] });
    expect(await callText(client, "rollout_undo", { namespace: "default", deploymentName: "web", cluster: "dev" }))
      .toMatch(/Unauthorized to invoke tool: rollout_undo\. Requires role release-manager or higher; caller has developer/);
  });

  it("requires an explicit cluster for mutating tools when several clusters are registered", async () => {
    useClusters([{ name: "dev" }, { name: "prod" }]);
    const client = await connect(admin);
    expect(await callText(client, "scale_deployment", { namespace: "default", deploymentName: "web", replicas: 2 }))
      .toMatch(/'cluster' must be specified explicitly.*dev, prod/);
    // Read-only tools still fall back to the default cluster
    expect(await callText(client, "list_pods", { namespace: "default" })).not.toMatch(/must be specified/);
  });

  it("allows mutating tools without a cluster when only one is registered", async () => {
    useClusters([{ name: "only" }]);
    const client = await connect(admin);
    expect(await callText(client, "scale_deployment", { namespace: "default", deploymentName: "web", replicas: 2 }))
      .not.toMatch(/must be specified/);
  });

  it("lists clusters from the registry with filters", async () => {
    useClusters([{ name: "a", cloud: "eks", labels: { env: "prod" } }, { name: "b", cloud: "gke" }]);
    const client = await connect({ oid: "dev", roles: ["developer"] });
    const listed = JSON.parse(await callText(client, "list_clusters", { cloud: "eks" }));
    expect(listed).toEqual([{ name: "a", provider: "kubeconfig", cloud: "eks", labels: { env: "prod" } }]);
  });

  it("rejects unknown clusters", async () => {
    useClusters([{ name: "dev" }]);
    const client = await connect(admin);
    expect(await callText(client, "list_pods", { namespace: "default", cluster: "staging" })).toMatch(/Unknown cluster 'staging'/);
  });

  it("enforces per-cluster policies, including both sides of compare_clusters", async () => {
    useClusters([{ name: "dev" }, { name: "prod", labels: { env: "prod" } }], {
      policies: [{ labels: { env: "prod" }, minRole: "sre" }, { match: "prod", denyTools: ["drain_node"] }],
    });
    const releaseManager = await connect({ oid: "rm", roles: ["release-manager"] });
    expect(await callText(releaseManager, "list_pods", { namespace: "default", cluster: "prod" })).toMatch(/requires role sre/);
    expect(await callText(releaseManager, "list_pods", { namespace: "default", cluster: "dev" })).not.toMatch(/Unauthorized/);
    expect(await callText(releaseManager, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "web", clusterA: "dev", clusterB: "prod" }))
      .toMatch(/requires role sre/);

    const platform = await connect(admin);
    expect(await callText(platform, "drain_node", { nodeName: "n1", cluster: "prod" })).toMatch(/disabled on cluster 'prod'/);
  });

  it("fails closed when policies exist and a target cluster cannot be resolved", async () => {
    useClusters([{ name: "dev" }], { policies: [{ match: "prod", minRole: "sre" }] });
    const client = await connect(admin);
    expect(await callText(client, "list_pods", { namespace: "default", cluster: "prod" })).toMatch(/Unauthorized.*Unknown cluster 'prod'/);
  });
});
