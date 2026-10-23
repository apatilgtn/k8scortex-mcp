/**
 * End-to-end matrix for K8sCortex against a real GKE cluster (see tests/e2e/gke/README.md).
 *
 * The same cluster is registered twice through CLUSTERS_CONFIG:
 *   gke-adc         provider "gke": endpoint and CA from the GKE API, bearer token from Application Default Credentials
 *   gke-kubeconfig  provider "kubeconfig": a context written by `gcloud container clusters get-credentials`
 *
 * Suites:
 *   providers  both providers connect, detect GKE and report the same cluster
 *   tools      every registered tool against gke-adc (or TOOLS_CLUSTER), with output assertions and kubectl checks for writes
 *   policies   per-cluster policies and stdio roles against the real cluster
 *
 * Writes results JSON to RESULTS_FILE (default ./e2e-gke-results.json) and exits non-zero on any failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const CTX = required("GKE_CONTEXT");
const PROJECT = required("GKE_PROJECT");
const LOCATION = required("GKE_LOCATION");
const CLUSTER = required("GKE_CLUSTER");
const DRAIN_POOL = process.env.GKE_DRAIN_POOL || "spot-pool";
const NS = "kx-gke-e2e";
const ADC = "gke-adc";
const KCFG = "gke-kubeconfig";
// The tools suite runs against one of the two registrations (gke-adc unless TOOLS_CLUSTER says otherwise)
const TARGET = process.env.TOOLS_CLUSTER || ADC;
const RESULTS_FILE = process.env.RESULTS_FILE || "e2e-gke-results.json";
const WORK = mkdtempSync(join(tmpdir(), "k8scortex-gke-e2e-"));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

// ── Result recording ──────────────────────────────────────────────────────────

interface Result {
  suite: string;
  name: string;
  tool?: string;
  cluster?: string;
  status: "PASS" | "FAIL";
  ms: number;
  detail: string;
  output?: string;
}

const results: Result[] = [];
const coveredTools = new Set<string>();

function record(r: Result) {
  results.push(r);
  const mark = r.status === "PASS" ? "✓" : "✗";
  console.log(`${mark} [${r.suite}] ${r.name}${r.status === "FAIL" ? ` — ${r.detail}` : ""}`);
}

async function scenario(suite: string, name: string, fn: () => Promise<string | void>) {
  const started = Date.now();
  try {
    const detail = await fn();
    record({ suite, name, status: "PASS", ms: Date.now() - started, detail: detail || "ok" });
  } catch (err: any) {
    record({ suite, name, status: "FAIL", ms: Date.now() - started, detail: err.message });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ── kubectl helpers ───────────────────────────────────────────────────────────

function kubectl(args: string[]): string {
  return execFileSync("kubectl", ["--context", CTX, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function apply(manifest: object) {
  execFileSync("kubectl", ["--context", CTX, "apply", "-f", "-"], { input: JSON.stringify(manifest), stdio: ["pipe", "ignore", "pipe"] });
}

function jsonpath(resource: string, path: string, ns: string | null = NS): string {
  return kubectl([...(ns ? ["-n", ns] : []), "get", ...resource.split(/\s+/), "-o", `jsonpath=${path}`]);
}

function exists(resource: string, ns: string | null = NS): boolean {
  try {
    kubectl([...(ns ? ["-n", ns] : []), "get", ...resource.split(/\s+/)]);
    return true;
  } catch {
    return false;
  }
}

/** True once the object is gone or being deleted (the object can disappear between two kubectl calls). */
function deleting(resource: string, ns: string | null = NS): boolean {
  try {
    return jsonpath(resource, "{.metadata.deletionTimestamp}", ns) !== "";
  } catch {
    return true;
  }
}

async function eventually(check: () => boolean, message: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(message);
}

// ── MCP client helpers ────────────────────────────────────────────────────────

interface CallOutcome { ok: boolean; text: string; ms: number }

async function call(client: Client, tool: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const started = Date.now();
  try {
    const res: any = await client.callTool({ name: tool, arguments: args });
    return { ok: !res.isError, text: res.content?.[0]?.text ?? "", ms: Date.now() - started };
  } catch (err: any) {
    return { ok: false, text: err.message, ms: Date.now() - started };
  }
}

function writeRegistry(extra: object = {}): string {
  const path = join(WORK, `clusters-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    defaultCluster: ADC,
    clusters: [
      { name: ADC, provider: "gke", project: PROJECT, location: LOCATION, gkeClusterName: CLUSTER, region: LOCATION, labels: { env: "e2e", auth: "adc" } },
      { name: KCFG, provider: "kubeconfig", context: CTX, cloud: "gke", region: LOCATION, labels: { env: "e2e", auth: "kubeconfig" } },
    ],
    ...extra,
  }, null, 2));
  return path;
}

async function stdioClient(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(ROOT, "dist/stdio.js")],
    env: { ...process.env as Record<string, string>, CLUSTERS_CONFIG: writeRegistry(), AUDIT_LOG_FILE: join(WORK, "stdio-audit.log"), ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "gke-e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

type Expectation = RegExp | ((text: string) => string | void);

/** Runs a tool and checks its output; verify() can inspect the cluster afterwards. */
async function toolCase(
  client: Client,
  suite: string,
  tool: string,
  args: Record<string, unknown>,
  expect: Expectation[],
  opts: { label?: string; expectError?: boolean; verify?: () => Promise<void> | void } = {}
) {
  coveredTools.add(tool);
  const out = await call(client, tool, args);
  const name = opts.label ? `${tool} — ${opts.label}` : tool;
  const problems: string[] = [];
  if (opts.expectError ? out.ok : !out.ok) problems.push(opts.expectError ? "expected an error" : `tool error: ${out.text.slice(0, 300)}`);
  for (const e of expect) {
    if (e instanceof RegExp) {
      if (!e.test(out.text)) problems.push(`output does not match ${e}`);
    } else {
      try { const msg = e(out.text); if (msg) problems.push(msg); } catch (err: any) { problems.push(err.message); }
    }
  }
  if (!problems.length && opts.verify) {
    try { await opts.verify(); } catch (err: any) { problems.push(`cluster check: ${err.message}`); }
  }
  record({
    suite, name, tool, cluster: String(args.cluster ?? args.clusterA ?? ""),
    status: problems.length ? "FAIL" : "PASS", ms: out.ms,
    detail: problems.join("; ") || "ok",
    output: out.text.slice(0, 600),
  });
  return out;
}

const json = (text: string) => JSON.parse(text);

// ── Real cluster facts the assertions are checked against ─────────────────────

const nodesInPool = (pool: string) => jsonpath(`nodes -l cloud.google.com/gke-nodepool=${pool}`, "{.items[*].metadata.name}", null).split(" ").filter(Boolean);
const serverMinor = () => json(kubectl(["version", "-o", "json"])).serverVersion.minor.replace(/\D/g, "");

// ── Suite: both providers reach the same cluster ──────────────────────────────

async function providersSuite() {
  const S = "providers";
  const c = await stdioClient();
  const minor = serverMinor();
  const nodeCount = jsonpath("nodes", "{.items[*].metadata.name}", null).split(" ").length;

  await toolCase(c, S, "list_clusters", {}, [new RegExp(ADC), new RegExp(KCFG), /"provider": "gke"/, /"provider": "kubeconfig"/]);
  await toolCase(c, S, "list_clusters", { labelSelector: "auth=adc" }, [(t) => {
    const names = json(t).map((x: any) => x.name);
    if (names.join() !== ADC) return `expected only ${ADC}, got ${names.join()}`;
  }], { label: "label selector" });

  for (const cluster of [ADC, KCFG]) {
    await toolCase(c, S, "get_cluster_info", { cluster }, [/"platform": "gke"/, new RegExp(`v1\\.${minor}`), (t) => {
      const info = json(t);
      const count = info.nodeCount ?? info.nodes?.length;
      if (count !== nodeCount) return `nodeCount ${count} != kubectl's ${nodeCount}`;
    }], { label: cluster });
  }

  await toolCase(c, S, "list_pods", { namespace: NS, cluster: KCFG }, [/fixture-deploy-/, /fixture-logger-/], { label: `${KCFG} reads workloads` });
  await toolCase(c, S, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "test-app", clusterA: ADC, clusterB: KCFG }, [/"driftDetected": false/], { label: "same cluster through both providers" });

  await scenario(S, "gke provider reports a clear error for an unknown cluster", async () => {
    const path = join(WORK, "missing-cluster.json");
    writeFileSync(path, JSON.stringify({ clusters: [{ name: "missing", provider: "gke", project: PROJECT, location: LOCATION, gkeClusterName: "does-not-exist-k8scortex" }] }));
    const bad = await stdioClient({ CLUSTERS_CONFIG: path });
    const out = await call(bad, "list_nodes", { cluster: "missing" });
    await bad.close();
    assert(!out.ok, "expected an error");
    assert(/404|not found|NOT_FOUND/i.test(out.text), `unhelpful error: ${out.text.slice(0, 200)}`);
    return out.text.slice(0, 120);
  });

  await c.close();
}

// ── Suite: every tool against TARGET ──────────────────────────────────────────

async function toolsSuite() {
  const S = "tools";
  const c = await stdioClient();
  const cl = { cluster: TARGET };
  const pod = (app = "fixture-deploy") => jsonpath(`pods -l app=${app} --field-selector=status.phase=Running`, "{.items[0].metadata.name}");
  const firstPod = pod();
  const loggerPod = pod("fixture-logger");
  const defaultPool = jsonpath("nodes", "{.items[*].metadata.labels.cloud\\.google\\.com/gke-nodepool}", null).split(" ").find(p => p !== DRAIN_POOL)!;
  const drainNode = nodesInPool(DRAIN_POOL)[0];
  const workNode = nodesInPool(defaultPool)[0];
  const runId = Date.now() % 100000;
  assert(drainNode, `no node in pool ${DRAIN_POOL}`);

  const registered = (await c.listTools()).tools.map(t => t.name);

  // Read-only workload tools
  await toolCase(c, S, "list_pods", { namespace: NS, ...cl }, [/fixture-deploy-/, /fixture-sts-0/]);
  await toolCase(c, S, "describe_pod", { namespace: NS, podName: firstPod, ...cl }, [new RegExp(firstPod), /nginx:1\.28-alpine/]);
  await toolCase(c, S, "get_pod_logs", { namespace: NS, podName: loggerPod, tailLines: 2, ...cl }, [/slow upstream response \d+/, (t) => (t.includes("fixture app started") ? "tailLines=2 returned more than 2 lines" : undefined)]);
  await toolCase(c, S, "describe_deployment", { namespace: NS, deploymentName: "fixture-deploy", ...cl }, [/nginx:1\.28-alpine/]);
  await toolCase(c, S, "list_nodes", cl, [new RegExp(workNode), new RegExp(drainNode)]);
  await toolCase(c, S, "list_statefulsets", { namespace: NS, ...cl }, [/fixture-sts/]);
  await toolCase(c, S, "describe_statefulset", { namespace: NS, statefulSetName: "fixture-sts", ...cl }, [/busybox/]);
  const kubeSystemDs = jsonpath("daemonsets", "{.items[*].metadata.name}", "kube-system").split(" ").filter(Boolean);
  await toolCase(c, S, "list_daemonsets", { namespace: "kube-system", ...cl }, kubeSystemDs.slice(0, 3).map(d => new RegExp(d)));
  await toolCase(c, S, "describe_daemonset", { namespace: "kube-system", daemonSetName: kubeSystemDs[0], ...cl }, [new RegExp(kubeSystemDs[0])]);
  await toolCase(c, S, "rollout_status", { namespace: NS, deploymentName: "fixture-deploy", ...cl }, [/fixture-deploy/]);

  // Configuration and observability
  await toolCase(c, S, "get_configmap", { namespace: NS, configMapName: "fixture-config", ...cl }, [/LOG_LEVEL/, /FEATURE_X/]);
  await toolCase(c, S, "describe_namespace_quota", { namespace: NS, ...cl }, [/requests\.cpu/]);
  // A real namespace has well over 50 events by now; the newest one must still be listed
  const now = new Date().toISOString();
  apply({
    apiVersion: "v1", kind: "Event", metadata: { name: `e2e-recent-${runId}`, namespace: NS },
    involvedObject: { kind: "Deployment", name: "fixture-deploy", namespace: NS },
    reason: "E2ERecent", message: `newest event ${runId}`, type: "Warning", count: 1, firstTimestamp: now, lastTimestamp: now,
  });
  // Other controllers keep emitting events, so check order and presence rather than position
  const newestFirst = (t: string) => {
    const items = json(t);
    const times = items.map((e: any) => Date.parse(e.time));
    if (times.some((x: number, i: number) => i > 0 && x > times[i - 1])) return "events are not sorted newest first";
    if (!items.some((e: any) => e.reason === "E2ERecent")) return "the newest event is missing";
  };
  await toolCase(c, S, "list_events", { namespace: NS, ...cl }, [newestFirst]);
  await toolCase(c, S, "list_persistent_volume_claims", { namespace: NS, ...cl }, [/fixture-pvc/]);
  await toolCase(c, S, "get_effective_permissions", { namespace: NS, serviceAccountName: "wi-sa", ...cl }, []);
  await toolCase(c, S, "get_hpa_status", { namespace: NS, hpaName: "fixture-deploy", ...cl }, [/"currentReplicas": \d/, /AbleToScale/]);
  await toolCase(c, S, "list_warning_events", { namespace: NS, ...cl }, [/Back-off restarting failed container/, newestFirst]);
  await toolCase(c, S, "get_node_pressure", { nodeName: workNode, ...cl }, [/MemoryPressure/, /DiskPressure/]);
  await toolCase(c, S, "list_ingresses", { namespace: NS, ...cl }, [/fixture-ingress/, /fixture\.example\.com/]);
  const endpointIp = jsonpath(`pods -l app=fixture-deploy`, "{.items[0].status.podIP}");
  await toolCase(c, S, "get_service_endpoints", { namespace: NS, serviceName: "fixture-deploy", ...cl }, [new RegExp(endpointIp.replace(/\./g, "\\."))]);
  await toolCase(c, S, "list_jobs", { namespace: NS, ...cl }, []);
  await toolCase(c, S, "list_cronjobs", { namespace: NS, ...cl }, [/fixture-cron/]);

  // Resource intelligence (GKE's real metrics-server)
  await toolCase(c, S, "get_resource_recommendations", { namespace: NS, deploymentName: "fixture-deploy", ...cl }, [/currentRequests/, /heuristicRecommendation/]);
  await toolCase(c, S, "get_cluster_resource_utilisation", cl, [new RegExp(workNode)]);

  // Cloud awareness (real GKE labels, Workload Identity, PD CSI and addons)
  await toolCase(c, S, "list_node_pools", cl, [new RegExp(defaultPool), new RegExp(DRAIN_POOL), /"gke"/]);
  await toolCase(c, S, "get_node_pool_detail", { poolName: DRAIN_POOL, ...cl }, [new RegExp(drainNode), /"spot": true/]);
  await toolCase(c, S, "get_workload_identity_config", { namespace: NS, serviceAccountName: "wi-sa", ...cl }, [/app@demo-proj\.iam\.gserviceaccount\.com/]);
  await toolCase(c, S, "validate_workload_identity", { namespace: NS, serviceAccountName: "wi-sa", ...cl }, [/gke/]);
  await toolCase(c, S, "list_pod_disruption_budgets", { namespace: NS, ...cl }, [/fixture-pdb/]);
  await toolCase(c, S, "get_pdb_status", { namespace: NS, pdbName: "fixture-pdb", ...cl }, [/fixture-pdb|minAvailable/]);
  await toolCase(c, S, "list_vpas", { namespace: NS, ...cl }, [/fixture-vpa/]);
  await toolCase(c, S, "get_vpa_recommendation", { namespace: NS, vpaName: "fixture-vpa", ...cl }, [/150m/, /96Mi/]);
  await toolCase(c, S, "list_storage_classes", cl, [/standard-rwo/, /premium-rwo/]);
  await toolCase(c, S, "get_storage_class", { storageClassName: "standard-rwo", ...cl }, [/pd\.csi\.storage\.gke\.io/]);
  await toolCase(c, S, "get_addon_health", cl, [(t) => {
    const s = json(t);
    const bad = Object.entries(s).filter(([, v]: any) => v?.status && v.status !== "healthy").map(([k, v]: any) => `${k}=${v.status}`);
    if (bad.length) return `not healthy on a healthy GKE cluster: ${bad.join(", ")}`;
  }]);
  await toolCase(c, S, "list_limit_ranges", { namespace: NS, ...cl }, [/fixture-limits/, /500m/]);

  // Generic read
  await toolCase(c, S, "list_k8s_resources", { apiGroup: "apps", version: "v1", resource: "deployments", namespace: NS, ...cl }, [/fixture-deploy/]);
  await toolCase(c, S, "get_k8s_resource", { apiGroup: "apps", version: "v1", resource: "deployments", name: "fixture-deploy", namespace: NS, ...cl }, [/nginx:1\.28-alpine/]);
  await toolCase(c, S, "list_k8s_resources", { apiGroup: "argoproj.io", version: "v1alpha1", resource: "applications", namespace: "argocd", ...cl }, [/test-app/], { label: "CRD (Argo CD applications)" });
  await toolCase(c, S, "list_k8s_resources", { apiGroup: "networking.gke.io", version: "v1", resource: "managedcertificates", namespace: NS, ...cl }, [], { label: "GKE-specific CRD" });
  await toolCase(c, S, "list_k8s_resources", { version: "v1", resource: "secrets", namespace: NS, ...cl }, [/not permitted/], { label: "secrets are blocked", expectError: true });

  // GitOps
  await toolCase(c, S, "get_gitops_app_status", { engine: "argocd", namespace: "argocd", appName: "test-app", ...cl }, [/Synced/, /a1b2c3d4/]);
  await toolCase(c, S, "get_gitops_diff", { engine: "argocd", namespace: "argocd", appName: "test-app", ...cl }, []);
  await toolCase(c, S, "get_gitops_app_status", { engine: "flux", namespace: NS, appName: "fixture-kustomization", ...cl }, [/a1b2c3d4/], { label: "flux" });
  await toolCase(c, S, "list_flux_kustomizations", { namespace: NS, ...cl }, [/fixture-kustomization/, /main@sha1:a1b2c3d4/, /"ready": "True"/]);
  await toolCase(c, S, "list_flux_helm_releases", { namespace: NS, ...cl }, [/fixture-helmrelease/, /podinfo/, /6\.7\.0/]);
  await toolCase(c, S, "get_flux_helm_release", { namespace: NS, name: "fixture-helmrelease", ...cl }, [/podinfo/]);
  await toolCase(c, S, "list_flux_sources", { namespace: NS, ...cl }, [/fixture-repo/, /fixture-charts/]);
  await toolCase(c, S, "list_flux_alerts", { namespace: NS, ...cl }, [/fixture-alert/]);
  await toolCase(c, S, "sync_gitops_app", { engine: "argocd", namespace: "argocd", appName: "test-app", ...cl }, [/DRY RUN/], { label: "dry run (default)" });
  await toolCase(c, S, "sync_gitops_app", { engine: "argocd", namespace: "argocd", appName: "test-app", dryRun: false, ...cl }, [/Successfully triggered sync/], {
    label: "argocd",
    verify: () => assert(jsonpath("application test-app", "{.operation.sync}", "argocd") || jsonpath("application test-app", "{.metadata.annotations}", "argocd").includes("refresh"), "no sync operation or refresh annotation on the Application"),
  });
  await toolCase(c, S, "sync_gitops_app", { engine: "flux", namespace: NS, appName: "fixture-kustomization", dryRun: false, ...cl }, [/Successfully triggered sync/], {
    label: "flux",
    verify: () => assert(jsonpath("kustomization fixture-kustomization", "{.metadata.annotations.reconcile\\.fluxcd\\.io/requestedAt}"), "reconcile.fluxcd.io/requestedAt not set"),
  });
  await toolCase(c, S, "suspend_flux_resource", { resourceType: "kustomization", namespace: NS, name: "fixture-kustomization", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath("kustomization fixture-kustomization", "{.spec.suspend}") === "true", "spec.suspend is not true"),
  });
  await toolCase(c, S, "resume_flux_resource", { resourceType: "kustomization", namespace: NS, name: "fixture-kustomization", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath("kustomization fixture-kustomization", "{.spec.suspend}") !== "true", "spec.suspend is still true"),
  });

  // Deployment lifecycle (writes verified with kubectl, pods really roll)
  await toolCase(c, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 3, ...cl }, [/DRY RUN/], {
    label: "defaults to dry run",
    verify: () => assert(jsonpath("deployment fixture-deploy", "{.spec.replicas}") !== "3", "replicas changed during a dry run"),
  });
  await toolCase(c, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 3, dryRun: false, ...cl }, [], {
    label: "real",
    // Checked straight away: the fixture HPA (min 2) may scale it back down within its 15s sync period
    verify: () => assert(jsonpath("deployment fixture-deploy", "{.spec.replicas}") === "3", "spec.replicas is not 3"),
  });
  await toolCase(c, S, "rollout_undo", { namespace: NS, deploymentName: "fixture-deploy", dryRun: false, ...cl }, [], {
    verify: () => eventually(() => jsonpath("deployment fixture-deploy", "{.spec.template.spec.containers[0].image}") === "nginx:1.27-alpine", "image was not rolled back to nginx:1.27-alpine"),
  });
  await toolCase(c, S, "set_resource_limits", { namespace: NS, deploymentName: "fixture-deploy", containerName: "fixture-deploy", cpuRequest: "25m", cpuLimit: "150m", memoryRequest: "40Mi", memoryLimit: "96Mi", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath("deployment fixture-deploy", "{.spec.template.spec.containers[0].resources.limits.cpu}") === "150m", "cpu limit is not 150m"),
  });
  kubectl(["-n", NS, "rollout", "status", "deployment/fixture-deploy", "--timeout=180s"]);
  const victim = pod();
  await toolCase(c, S, "restart_pod", { namespace: NS, podName: victim, dryRun: false, ...cl }, [], {
    verify: () => eventually(() => deleting(`pod ${victim}`), `pod ${victim} was not deleted`),
  });
  await toolCase(c, S, "create_deployment", { namespace: NS, deploymentName: "e2e-created", image: "nginx:alpine", replicas: 1, port: 80, dryRun: false, ...cl }, [], {
    verify: () => eventually(() => jsonpath("deployment e2e-created", "{.status.readyReplicas}") === "1", "created deployment never became ready", 180_000),
  });
  await toolCase(c, S, "delete_deployment", { namespace: NS, deploymentName: "e2e-created", dryRun: false, ...cl }, [], {
    verify: () => eventually(() => !exists("deployment e2e-created"), "deployment still exists"),
  });

  // Jobs (the job really runs to completion)
  await toolCase(c, S, "create_job", { namespace: NS, jobName: `e2e-job-${runId}`, image: "busybox:1.36", command: ["echo", "hi"], dryRun: false, ...cl }, [], {
    verify: () => eventually(() => jsonpath(`job e2e-job-${runId}`, "{.status.succeeded}") === "1", "job did not complete", 180_000),
  });
  await toolCase(c, S, "list_jobs", { namespace: NS, ...cl }, [new RegExp(`e2e-job-${runId}`)], { label: "after create_job" });
  await toolCase(c, S, "suspend_cronjob", { namespace: NS, cronJobName: "fixture-cron", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath("cronjob fixture-cron", "{.spec.suspend}") === "true", "cronjob not suspended"),
  });
  await toolCase(c, S, "resume_cronjob", { namespace: NS, cronJobName: "fixture-cron", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath("cronjob fixture-cron", "{.spec.suspend}") === "false", "cronjob still suspended"),
  });

  // Config management
  await toolCase(c, S, "create_configmap", { namespace: NS, configMapName: `e2e-cm-${runId}`, data: { A: "1" }, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(`configmap e2e-cm-${runId}`, "{.data.A}") === "1", "configmap missing or wrong data"),
  });
  await toolCase(c, S, "update_configmap", { namespace: NS, configMapName: `e2e-cm-${runId}`, data: { B: "2" }, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(`configmap e2e-cm-${runId}`, "{.data.B}") === "2", "configmap not updated"),
  });
  await toolCase(c, S, "create_secret", { namespace: NS, secretName: `e2e-secret-${runId}`, stringData: { TOKEN: "s3cr3t-value" }, dryRun: false, ...cl }, [(t) => (t.includes("s3cr3t-value") ? "secret value echoed in tool output" : undefined)], {
    verify: () => assert(Buffer.from(jsonpath(`secret e2e-secret-${runId}`, "{.data.TOKEN}"), "base64").toString() === "s3cr3t-value", "secret missing or wrong value"),
  });
  await toolCase(c, S, "update_secret", { namespace: NS, secretName: `e2e-secret-${runId}`, stringData: { TOKEN: "rotated-value" }, dryRun: false, ...cl }, [], {
    verify: () => assert(Buffer.from(jsonpath(`secret e2e-secret-${runId}`, "{.data.TOKEN}"), "base64").toString() === "rotated-value", "secret not rotated"),
  });

  // Namespaces, autoscaling, networking
  await toolCase(c, S, "create_namespace", { namespaceName: `e2e-ns-${runId}`, dryRun: false, ...cl }, [], {
    verify: () => assert(exists(`namespace e2e-ns-${runId}`, null), "namespace not created"),
  });
  await toolCase(c, S, "delete_namespace", { namespaceName: `e2e-ns-${runId}`, dryRun: false, ...cl }, [], {
    verify: () => eventually(() => deleting(`namespace e2e-ns-${runId}`, null), "namespace not deleted"),
  });
  await toolCase(c, S, "create_horizontal_pod_autoscaler", { namespace: NS, hpaName: `e2e-hpa-${runId}`, targetDeployment: "fixture-deploy", minReplicas: 1, maxReplicas: 3, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(`hpa e2e-hpa-${runId}`, "{.spec.maxReplicas}") === "3", "HPA not created"),
  });
  await toolCase(c, S, "create_service", { namespace: NS, serviceName: `e2e-svc-${runId}`, port: 8080, targetPort: 80, selector: { app: "fixture-deploy" }, dryRun: false, ...cl }, [], {
    verify: () => eventually(() => jsonpath(`endpoints e2e-svc-${runId}`, "{.subsets[0].addresses[0].ip}") !== "", "service has no ready endpoints"),
  });
  await toolCase(c, S, "update_ingress", { namespace: NS, ingressName: "fixture-ingress", annotations: { "e2e/updated": "yes" }, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath("ingress fixture-ingress", "{.metadata.annotations.e2e/updated}") === "yes", "annotation not set"),
  });
  await toolCase(c, S, "create_network_policy", { namespace: NS, policyName: `e2e-np-${runId}`, podSelector: {}, policyTypes: ["Ingress"], dryRun: false, ...cl }, [], {
    verify: () => assert(exists(`networkpolicy e2e-np-${runId}`), "network policy not created"),
  });

  // Node administration on the dedicated spot node
  await toolCase(c, S, "cordon_node", { nodeName: drainNode, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(`node ${drainNode}`, "{.spec.unschedulable}", null) === "true", "node not cordoned"),
  });
  await toolCase(c, S, "uncordon_node", { nodeName: drainNode, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(`node ${drainNode}`, "{.spec.unschedulable}", null) !== "true", "node still cordoned"),
  });
  kubectl(["taint", "node", drainNode, "existing=keep:PreferNoSchedule", "--overwrite"]);
  const taintKeys = () => jsonpath(`node ${drainNode}`, "{.spec.taints[*].key}", null).split(" ");
  await toolCase(c, S, "taint_node", { nodeName: drainNode, key: "e2e", value: "test", effect: "NoSchedule", dryRun: false, ...cl }, [], {
    label: "adds a taint and keeps existing ones",
    verify: () => {
      assert(taintKeys().includes("e2e"), "taint not added");
      assert(taintKeys().includes("existing"), "existing taint was removed");
    },
  });
  await toolCase(c, S, "remove_taint", { nodeName: drainNode, key: "e2e", dryRun: false, ...cl }, [], {
    verify: () => {
      assert(!taintKeys().includes("e2e"), "taint still present");
      assert(taintKeys().includes("existing"), "unrelated taint was removed");
    },
  });
  kubectl(["taint", "node", drainNode, "existing-"]);
  // A pod pinned to the spot node so drain has something to evict
  kubectl(["-n", NS, "delete", "pod", "drain-victim", "--ignore-not-found", "--wait"]);
  kubectl(["-n", NS, "run", "drain-victim", "--image=busybox:1.36", "--restart=Never",
    `--overrides={"spec":{"nodeName":"${drainNode}","tolerations":[{"operator":"Exists"}]}}`, "--", "sleep", "3600"]);
  await eventually(() => jsonpath("pod drain-victim", "{.status.phase}") === "Running", "drain-victim never started", 120_000);
  await toolCase(c, S, "drain_node", { nodeName: drainNode, ...cl }, [/DRY RUN/], {
    label: "defaults to dry run",
    verify: () => assert(jsonpath(`node ${drainNode}`, "{.spec.unschedulable}", null) !== "true", "dry run cordoned the node"),
  });
  await toolCase(c, S, "drain_node", { nodeName: drainNode, force: true, dryRun: false, ...cl }, [/Evicted [1-9]/], {
    label: "real (eviction API)",
    verify: () => eventually(() => deleting("pod drain-victim"), "drain-victim was not evicted"),
  });
  kubectl(["uncordon", drainNode]);

  // Multi-cluster tools from this client
  await toolCase(c, S, "list_clusters", {}, [new RegExp(ADC), new RegExp(KCFG)]);
  await toolCase(c, S, "get_cluster_info", cl, [/"platform": "gke"/]);
  await toolCase(c, S, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "test-app", clusterA: ADC, clusterB: KCFG }, [/"driftDetected": false/]);

  await c.close();

  const missing = registered.filter(t => !coveredTools.has(t));
  await scenario(S, `coverage: all ${registered.length} registered tools exercised`, async () => {
    assert(!missing.length, `not exercised: ${missing.join(", ")}`);
  });
}

// ── Suite: policies and roles on the real cluster ─────────────────────────────

async function policiesSuite() {
  const S = "policies";
  const runId = Date.now() % 100000;

  const dev = await stdioClient({ K8SCORTEX_STDIO_ROLES: "developer" });
  await toolCase(dev, S, "list_pods", { namespace: NS, cluster: ADC }, [/fixture-deploy-/], { label: "developer can read" });
  await toolCase(dev, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 1, dryRun: false, cluster: ADC }, [/Unauthorized|requires|not permitted/i], {
    label: "developer cannot write", expectError: true,
    verify: () => assert(jsonpath("deployment fixture-deploy", "{.spec.replicas}") !== "1", "a developer scaled the deployment"),
  });
  await dev.close();

  const policed = await stdioClient({
    K8SCORTEX_STDIO_ROLES: "sre",
    CLUSTERS_CONFIG: writeRegistry({ policies: [
      // restart_pod is otherwise allowed for sre, so a denial can only come from the policy
      { labels: { auth: "adc" }, denyTools: ["restart_pod"] },
      { match: "gke-kube*", minRole: "platform-engineer", appliesTo: "mutating" },
    ] }),
  });
  const target = jsonpath("pods -l app=fixture-deploy", "{.items[0].metadata.name}");
  await toolCase(policed, S, "restart_pod", { namespace: NS, podName: target, dryRun: false, cluster: ADC }, [/disabled on cluster 'gke-adc' by policy/], {
    label: "denyTools by label", expectError: true,
    verify: () => assert(!deleting(`pod ${target}`), "the pod was deleted despite the policy"),
  });
  await toolCase(policed, S, "list_pods", { namespace: NS, cluster: KCFG }, [/fixture-deploy-/], { label: "minRole on mutating leaves reads alone" });
  await toolCase(policed, S, "create_configmap", { namespace: NS, configMapName: `policy-blocked-${runId}`, data: { A: "1" }, dryRun: false, cluster: KCFG }, [/requires role platform-engineer/], {
    label: "minRole by name glob", expectError: true,
    verify: () => assert(!exists(`configmap policy-blocked-${runId}`), "configmap was created despite the policy"),
  });
  await toolCase(policed, S, "create_configmap", { namespace: NS, configMapName: `policy-allowed-${runId}`, data: { A: "1" }, dryRun: false, cluster: ADC }, [], {
    label: "other cluster unaffected",
    verify: () => assert(exists(`configmap policy-allowed-${runId}`), "configmap not created"),
  });
  await toolCase(policed, S, "list_pods", { namespace: NS }, [/fixture-deploy-/], { label: "reads fall back to defaultCluster" });
  await toolCase(policed, S, "create_configmap", { namespace: NS, configMapName: "no-cluster", data: { A: "1" }, dryRun: false }, [/cluster/i], { label: "writes need an explicit cluster", expectError: true });
  await policed.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────

const suites: Record<string, () => Promise<void>> = { providers: providersSuite, tools: toolsSuite, policies: policiesSuite };
const selected = (process.env.SUITES || Object.keys(suites).join(",")).split(",").map(s => s.trim()).filter(Boolean);

for (const name of selected) {
  const suite = suites[name];
  if (!suite) throw new Error(`unknown suite '${name}' (expected ${Object.keys(suites).join(", ")})`);
  console.log(`\n── ${name} ──`);
  await suite().catch(err => record({ suite: name, name: "suite crashed", status: "FAIL", ms: 0, detail: err.stack || err.message }));
}

const failed = results.filter(r => r.status === "FAIL");
writeFileSync(RESULTS_FILE, JSON.stringify({
  cluster: { project: PROJECT, location: LOCATION, name: CLUSTER, context: CTX },
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed — results in ${RESULTS_FILE}`);
process.exit(failed.length ? 1 : 0);
