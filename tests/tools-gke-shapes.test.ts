/**
 * Tool behaviour against API responses shaped like a real GKE Standard cluster (1.36), served by a
 * local fake API server. These shapes broke tools that only had KWOK-style fixtures:
 * versioned addon names, kube-proxy as static pods, netd as the CNI, and >50 events in name order.
 * rollout_undo is checked here too: on a live cluster a full replace raced the HPA and failed with 409.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import * as k8s from "@kubernetes/client-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/server.js";
import { setClusterRegistry } from "../src/cluster-store.js";
import { createClusterRegistry } from "../src/clusters/registry.js";
import { ClusterEntry, ClusterProvider } from "../src/clusters/types.js";

const list = (kind: string, items: object[]) => ({ apiVersion: "v1", kind: `${kind}List`, metadata: {}, items });

const deploy = (name: string, app: string, ready: number) => ({
  metadata: { name, namespace: "kube-system", labels: { "k8s-app": app } },
  spec: { replicas: ready },
  status: { replicas: ready, readyReplicas: ready },
});

const daemonset = (name: string, desired: number, ready: number) => ({
  metadata: { name, namespace: "kube-system", labels: { "k8s-app": name } },
  status: { desiredNumberScheduled: desired, currentNumberScheduled: desired, numberReady: ready, numberMisscheduled: 0 },
});

// Kubernetes lists events by name, which is unrelated to when they happened: the newest sort last here
const base = Date.parse("2026-10-23T00:00:00Z");
const events = Array.from({ length: 60 }, (_, i) => ({
  metadata: { name: `ev-${String(i).padStart(3, "0")}`, namespace: "app", creationTimestamp: new Date(base + i * 1000).toISOString() },
  involvedObject: { kind: "Pod", name: `pod-${i}` },
  reason: i === 59 ? "BackOff" : "Pulled",
  message: i === 59 ? "newest event" : `event ${i}`,
  type: i % 2 ? "Warning" : "Normal",
  lastTimestamp: new Date(base + i * 1000).toISOString(),
}));

const routes: Record<string, (q: URLSearchParams) => object> = {
  "/apis/apps/v1/namespaces/kube-system/deployments": () => list("Deployment", [
    deploy("kube-dns", "kube-dns", 1),
    deploy("metrics-server-v1.36.0", "metrics-server", 1),
  ]),
  "/apis/apps/v1/namespaces/kube-system/daemonsets": () => list("DaemonSet", [
    daemonset("kube-proxy", 0, 0),
    daemonset("netd", 2, 2),
    daemonset("fluentbit-gke", 2, 2),
  ]),
  "/api/v1/namespaces/kube-system/pods": (q) => list("Pod", q.get("labelSelector") === "component=kube-proxy" ? [
    { metadata: { name: "kube-proxy-gke-node-1", namespace: "kube-system", labels: { component: "kube-proxy" } }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
  ] : []),
  "/api/v1/namespaces/app/events": (q) => list("Event", q.get("fieldSelector") === "type=Warning" ? events.filter(e => e.type === "Warning") : events),
  "/apis/apps/v1/namespaces/app/deployments/web": () => ({
    metadata: { name: "web", namespace: "app", resourceVersion: "100" },
    spec: { selector: { matchLabels: { app: "web" } }, template: template("hash-2", "nginx:1.28") },
  }),
  "/apis/apps/v1/namespaces/app/replicasets": () => list("ReplicaSet", [1, 2].map(rev => ({
    metadata: {
      name: `web-hash-${rev}`, namespace: "app",
      annotations: { "deployment.kubernetes.io/revision": String(rev) },
      ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "u", controller: true }],
    },
    spec: { selector: { matchLabels: { app: "web" } }, template: template(`hash-${rev}`, rev === 1 ? "nginx:1.27" : "nginx:1.28") },
  }))),
};

function template(hash: string, image: string) {
  return { metadata: { labels: { app: "web", "pod-template-hash": hash } }, spec: { containers: [{ name: "web", image }] } };
}

let api: Server;
let apiUrl: string;
const writes: Array<{ method: string; path: string; contentType?: string; body: any }> = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    let raw = "";
    req.on("data", d => (raw += d)).on("end", () => {
      if (req.method !== "GET") writes.push({ method: req.method!, path: url.pathname, contentType: req.headers["content-type"], body: raw && JSON.parse(raw) });
      const route = routes[url.pathname];
      res.writeHead(route ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(route ? route(url.searchParams) : { kind: "Status", code: 404 }));
    });
  });
  await new Promise<void>(r => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => api.close());
afterEach(() => setClusterRegistry(undefined));

const fakeGke: ClusterProvider = {
  id: "kubeconfig",
  list: async () => [],
  getKubeConfig: async (e) => {
    const kc = new k8s.KubeConfig();
    kc.loadFromOptions({
      // The client only allows plain HTTP with skipTLSVerify
      clusters: [{ name: e.name, server: apiUrl, skipTLSVerify: true }],
      users: [{ name: "u", token: "t" }],
      contexts: [{ name: e.name, cluster: e.name, user: "u" }],
      currentContext: e.name,
    });
    return { kc, expiresAt: Date.now() + 60_000 };
  },
};

async function callText(name: string, args: object): Promise<string> {
  setClusterRegistry(createClusterRegistry({
    discover: async () => [{ name: "gke", provider: "kubeconfig", cloud: "gke" } as ClusterEntry],
    providers: { kubeconfig: fakeGke },
    defaultCluster: () => "gke",
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(() => ({ oid: "t", roles: ["platform-engineer"] })).connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  const res: any = await client.callTool({ name, arguments: { cluster: "gke", ...args } });
  await client.close();
  expect(res.isError, res.content?.[0]?.text).toBeFalsy();
  return res.content[0].text;
}

const callJson = async (name: string, args: object) => JSON.parse(await callText(name, args));

describe("GKE-shaped clusters", () => {
  it("get_addon_health recognises GKE's versioned metrics-server, static kube-proxy and netd", async () => {
    const health = await callJson("get_addon_health", {});
    expect(health.coredns.status).toBe("healthy");
    expect(health.metricsServer).toMatchObject({ status: "healthy", name: "metrics-server-v1.36.0" });
    expect(health.kubeProxy).toMatchObject({ status: "healthy", mode: "static-pods", numberReady: 1 });
    expect(health.cni).toMatchObject({ status: "healthy", name: "netd" });
  });

  it("list_events returns the 50 most recent events, newest first", async () => {
    const out = await callJson("list_events", { namespace: "app" });
    expect(out).toHaveLength(50);
    expect(out[0]).toMatchObject({ reason: "BackOff", message: "newest event" });
    expect(out.map((e: any) => e.object)).not.toContain("Pod/pod-0");
  });

  it("list_warning_events sorts newest first", async () => {
    const out = await callJson("list_warning_events", { namespace: "app" });
    expect(out[0]).toMatchObject({ reason: "BackOff", message: "newest event" });
  });
});

describe("rollout_undo", () => {
  it("patches only the template (no resourceVersion to conflict on) and drops the old ReplicaSet's hash label", async () => {
    writes.length = 0;
    await callText("rollout_undo", { namespace: "app", deploymentName: "web", dryRun: false });
    expect(writes).toHaveLength(1);
    const [w] = writes;
    expect(w).toMatchObject({ method: "PATCH", path: "/apis/apps/v1/namespaces/app/deployments/web", contentType: "application/json-patch+json" });
    expect(w.body).toEqual([{ op: "replace", path: "/spec/template", value: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "nginx:1.27" }] } } }]);
  });
});
