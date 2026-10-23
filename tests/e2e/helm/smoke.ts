/**
 * Smoke test for the Helm chart: talks to an installed release over Streamable HTTP with signed
 * test tokens and checks roles, in-cluster access and the chart's RBAC (see tests/e2e/helm/run.sh).
 *
 *   MCP_URL         e.g. http://localhost:3000/mcp (a port-forward to the release's Service)
 *   TEST_JWT_SECRET the secret the release was installed with (extraEnv)
 *   EXPECT_WRITES   "true" when installed with rbac.allowWrites=true
 */
import { execFileSync } from "node:child_process";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL || "http://localhost:3000/mcp";
const SECRET = process.env.TEST_JWT_SECRET!;
const EXPECT_WRITES = process.env.EXPECT_WRITES === "true";
const NS = "kx-helm-smoke";
let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

async function connect(roles: string[]) {
  const token = jwt.sign({ oid: `helm-${roles[0]}`, roles }, SECRET, { expiresIn: "5m" });
  const client = new Client({ name: "helm-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const res: any = await client.callTool({ name, arguments: args });
    return { ok: !res.isError, text: res.content?.[0]?.text ?? "" };
  } catch (err: any) {
    return { ok: false, text: err.message as string };
  }
}

const unauthenticated = await fetch(MCP_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
check("requests without a token are rejected", unauthenticated.status === 401, `HTTP ${unauthenticated.status}`);

const dev = await connect(["developer"]);
check("all tools are served", (await dev.listTools()).tools.length === 75);

const clusters = await call(dev, "list_clusters", {});
const cluster = JSON.parse(clusters.text)[0]?.name;
check("the in-cluster service account is registered as a cluster", clusters.ok && !!cluster, clusters.text.slice(0, 200));

const pods = await call(dev, "list_pods", { namespace: "kube-system", cluster });
check("developer reads pods through the in-cluster identity", pods.ok && /coredns|kube-proxy/.test(pods.text), pods.text.slice(0, 200));

const info = await call(dev, "get_cluster_info", { cluster });
check("get_cluster_info reaches the API server", info.ok && /"kubernetesVersion"|"version"/.test(info.text), info.text.slice(0, 200));

const secrets = await call(dev, "list_k8s_resources", { version: "v1", resource: "secrets", namespace: "kube-system", cluster });
check("generic reads refuse Secrets", !secrets.ok && /not permitted/.test(secrets.text), secrets.text.slice(0, 200));

const devWrite = await call(dev, "create_namespace", { namespaceName: NS, dryRun: false, cluster });
check("developer cannot write (role table)", !devWrite.ok && /Unauthorized/.test(devWrite.text), devWrite.text.slice(0, 200));
await dev.close();

const admin = await connect(["platform-engineer"]);
const write = await call(admin, "create_namespace", { namespaceName: NS, dryRun: false, cluster });
if (EXPECT_WRITES) {
  const exists = (() => { try { execFileSync("kubectl", ["get", "namespace", NS], { stdio: "ignore" }); return true; } catch { return false; } })();
  check("platform-engineer writes when rbac.allowWrites=true", write.ok && exists, write.text.slice(0, 200));
  const del = await call(admin, "delete_namespace", { namespaceName: NS, dryRun: false, cluster });
  check("and cleans up", del.ok, del.text.slice(0, 200));
} else {
  check("Kubernetes RBAC blocks writes when rbac.allowWrites=false", !write.ok && /403|forbidden/i.test(write.text), write.text.slice(0, 200));
}
await admin.close();

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
