/**
 * End-to-end scenario matrix for K8sCortex against two KWOK clusters (see tests/e2e/kwok/README.md).
 *
 * Suites:
 *   tools        every registered tool against kwok-dev, with output assertions and kubectl checks for writes
 *   multicluster routing, platform detection and drift between kwok-dev (GKE-like) and kwok-prod (EKS-like)
 *   registry     CLUSTERS_CONFIG: named clusters, labels, default cluster and per-cluster policies over stdio
 *   http-auth    HTTP transports with a local OIDC issuer: role matrix, policies, sessions, generic read guards
 *   audit        audit records: identity, resolved cluster/provider, secret redaction
 *   startup      configuration errors stop the server
 *
 * Writes results JSON to RESULTS_FILE (default ./e2e-results.json) and exits non-zero on any failure.
 */
import { execFileSync, spawn, ChildProcess } from "node:child_process";
import { createServer, Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const DEV = process.env.DEV_CONTEXT || "kwok-dev";
const PROD = process.env.PROD_CONTEXT || "kwok-prod";
const NS = "kx-e2e-fixture";
const RESULTS_FILE = process.env.RESULTS_FILE || "e2e-results.json";
const WORK = mkdtempSync(join(tmpdir(), "k8scortex-e2e-"));

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

function kubectl(context: string, args: string[]): string {
  return execFileSync("kubectl", ["--context", context, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function jsonpath(context: string, resource: string, path: string, ns: string | null = NS): string {
  return kubectl(context, [...(ns ? ["-n", ns] : []), "get", ...resource.split(/\s+/), "-o", `jsonpath=${path}`]);
}

function exists(context: string, resource: string, ns: string | null = NS): boolean {
  try {
    kubectl(context, [...(ns ? ["-n", ns] : []), "get", ...resource.split(/\s+/)]);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, message: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 500));
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

async function stdioClient(env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(ROOT, "dist/stdio.js")],
    env: { ...process.env as Record<string, string>, AUDIT_LOG_FILE: join(WORK, "stdio-audit.log"), ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "kwok-e2e", version: "1.0.0" }, { capabilities: {} });
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

// ── Suite: every tool against kwok-dev ────────────────────────────────────────

async function toolsSuite() {
  const S = "tools";
  const c = await stdioClient();
  const cl = { cluster: DEV };
  const pod = () => jsonpath(DEV, "pods -l app=fixture-deploy", "{.items[0].metadata.name}");
  const firstPod = pod();
  const runId = Date.now() % 100000;

  const registered = (await c.listTools()).tools.map(t => t.name);

  // Read-only workload tools
  await toolCase(c, S, "list_pods", { namespace: NS, ...cl }, [/fixture-deploy-/, /fixture-sts-0/]);
  await toolCase(c, S, "describe_pod", { namespace: NS, podName: firstPod, ...cl }, [new RegExp(firstPod), /nginx:1\.28-alpine/]);
  await toolCase(c, S, "get_pod_logs", { namespace: NS, podName: firstPod, tailLines: 2, ...cl }, [/slow upstream response/, (t) => (t.includes("fixture app started") ? "tailLines=2 returned more than 2 lines" : undefined)]);
  await toolCase(c, S, "describe_deployment", { namespace: NS, deploymentName: "fixture-deploy", ...cl }, [/nginx:1\.28-alpine/]);
  await toolCase(c, S, "list_nodes", cl, [/gke-dev-a-1/, /gke-dev-drain-1/]);
  await toolCase(c, S, "list_statefulsets", { namespace: NS, ...cl }, [/fixture-sts/]);
  await toolCase(c, S, "describe_statefulset", { namespace: NS, statefulSetName: "fixture-sts", ...cl }, [/postgres:16/]);
  await toolCase(c, S, "list_daemonsets", { namespace: "kube-system", ...cl }, [/kube-proxy/, /gke-node-config/]);
  await toolCase(c, S, "describe_daemonset", { namespace: "kube-system", daemonSetName: "kube-proxy", ...cl }, [/kube-proxy/]);
  await toolCase(c, S, "rollout_status", { namespace: NS, deploymentName: "fixture-deploy", ...cl }, [/fixture-deploy/]);

  // Configuration and observability
  await toolCase(c, S, "get_configmap", { namespace: NS, configMapName: "fixture-config", ...cl }, [/LOG_LEVEL/, /FEATURE_X/]);
  await toolCase(c, S, "describe_namespace_quota", { namespace: NS, ...cl }, [/requests\.cpu/]);
  await toolCase(c, S, "list_events", { namespace: NS, ...cl }, [/BackOff|Back-off/]);
  await toolCase(c, S, "list_persistent_volume_claims", { namespace: NS, ...cl }, [/fixture-pvc/]);
  await toolCase(c, S, "get_effective_permissions", { namespace: NS, serviceAccountName: "wi-sa", ...cl }, [/configmaps/]);
  await toolCase(c, S, "get_hpa_status", { namespace: NS, hpaName: "fixture-deploy", ...cl }, [/"currentReplicas": \d/, /AbleToScale/]);
  await toolCase(c, S, "list_warning_events", { namespace: NS, ...cl }, [/Back-off restarting failed container/]);
  await toolCase(c, S, "get_node_pressure", { nodeName: "gke-dev-a-1", ...cl }, [/gke-dev-a-1|MemoryPressure|Ready/]);
  await toolCase(c, S, "list_ingresses", { namespace: NS, ...cl }, [/fixture-ingress/, /fixture\.example\.com/]);
  await toolCase(c, S, "get_service_endpoints", { namespace: NS, serviceName: "fixture-deploy", ...cl }, [/10\.0\.\d+\.\d+/]);
  await toolCase(c, S, "list_jobs", { namespace: NS, ...cl }, []);
  await toolCase(c, S, "list_cronjobs", { namespace: NS, ...cl }, [/fixture-cron/]);

  // Resource intelligence (metrics-server simulated by KWOK)
  await toolCase(c, S, "get_resource_recommendations", { namespace: NS, deploymentName: "fixture-deploy", ...cl }, [/currentRequests/, /heuristicRecommendation/]);
  await toolCase(c, S, "get_cluster_resource_utilisation", cl, [/gke-dev-a-1/]);

  // Cloud awareness (GKE-like labels on kwok-dev)
  await toolCase(c, S, "list_node_pools", cl, [/default-pool/, /spot-pool/, /"gke"/]);
  await toolCase(c, S, "get_node_pool_detail", { poolName: "spot-pool", ...cl }, [/gke-dev-b-1/, /"spot": true/]);
  await toolCase(c, S, "get_workload_identity_config", { namespace: NS, serviceAccountName: "wi-sa", ...cl }, [/app@demo-proj\.iam\.gserviceaccount\.com/]);
  await toolCase(c, S, "validate_workload_identity", { namespace: NS, serviceAccountName: "wi-sa", ...cl }, [/gke/]);
  await toolCase(c, S, "list_pod_disruption_budgets", { namespace: NS, ...cl }, [/fixture-pdb/]);
  await toolCase(c, S, "get_pdb_status", { namespace: NS, pdbName: "fixture-pdb", ...cl }, [/fixture-pdb|minAvailable/]);
  await toolCase(c, S, "list_vpas", { namespace: NS, ...cl }, [/fixture-vpa/]);
  await toolCase(c, S, "get_vpa_recommendation", { namespace: NS, vpaName: "fixture-vpa", ...cl }, [/150m/, /96Mi/]);
  await toolCase(c, S, "list_storage_classes", cl, [/standard-rwo/]);
  await toolCase(c, S, "get_storage_class", { storageClassName: "standard-rwo", ...cl }, [/pd\.csi\.storage\.gke\.io/]);
  await toolCase(c, S, "get_addon_health", cl, [(t) => {
    const s = json(t);
    for (const k of ["coredns", "metricsServer", "kubeProxy", "cni"]) if (s[k]?.status !== "healthy") return `${k} is ${s[k]?.status}`;
  }]);
  await toolCase(c, S, "list_limit_ranges", { namespace: NS, ...cl }, [/fixture-limits/, /500m/]);

  // Generic read
  await toolCase(c, S, "list_k8s_resources", { apiGroup: "apps", version: "v1", resource: "deployments", namespace: NS, ...cl }, [/fixture-deploy/]);
  await toolCase(c, S, "get_k8s_resource", { apiGroup: "apps", version: "v1", resource: "deployments", name: "fixture-deploy", namespace: NS, ...cl }, [/nginx:1\.28-alpine/]);
  await toolCase(c, S, "list_k8s_resources", { apiGroup: "argoproj.io", version: "v1alpha1", resource: "applications", namespace: "argocd", ...cl }, [/test-app/], { label: "CRD (Argo CD applications)" });
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
    verify: () => assert(jsonpath(DEV, "application test-app", "{.operation.sync}", "argocd") || jsonpath(DEV, "application test-app", "{.metadata.annotations}", "argocd").includes("refresh"), "no sync operation or refresh annotation on the Application"),
  });
  await toolCase(c, S, "sync_gitops_app", { engine: "flux", namespace: NS, appName: "fixture-kustomization", dryRun: false, ...cl }, [/Successfully triggered sync/], {
    label: "flux",
    verify: () => assert(jsonpath(DEV, "kustomization fixture-kustomization", "{.metadata.annotations.reconcile\\.fluxcd\\.io/requestedAt}"), "reconcile.fluxcd.io/requestedAt not set"),
  });
  await toolCase(c, S, "suspend_flux_resource", { resourceType: "kustomization", namespace: NS, name: "fixture-kustomization", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, "kustomization fixture-kustomization", "{.spec.suspend}") === "true", "spec.suspend is not true"),
  });
  await toolCase(c, S, "resume_flux_resource", { resourceType: "kustomization", namespace: NS, name: "fixture-kustomization", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, "kustomization fixture-kustomization", "{.spec.suspend}") !== "true", "spec.suspend is still true"),
  });

  // Deployment lifecycle (writes verified with kubectl)
  await toolCase(c, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 4, ...cl }, [/DRY RUN/], {
    label: "defaults to dry run",
    verify: () => assert(jsonpath(DEV, "deployment fixture-deploy", "{.spec.replicas}") !== "4", "replicas changed during a dry run"),
  });
  await toolCase(c, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 4, dryRun: false, ...cl }, [], {
    label: "real",
    verify: () => assert(jsonpath(DEV, "deployment fixture-deploy", "{.spec.replicas}") === "4", "spec.replicas is not 4"),
  });
  await toolCase(c, S, "rollout_undo", { namespace: NS, deploymentName: "fixture-deploy", dryRun: false, ...cl }, [], {
    verify: () => eventually(() => jsonpath(DEV, "deployment fixture-deploy", "{.spec.template.spec.containers[0].image}") === "nginx:1.27-alpine", "image was not rolled back to nginx:1.27-alpine"),
  });
  await toolCase(c, S, "set_resource_limits", { namespace: NS, deploymentName: "fixture-deploy", containerName: "fixture-deploy", cpuRequest: "150m", cpuLimit: "300m", memoryRequest: "96Mi", memoryLimit: "192Mi", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, "deployment fixture-deploy", "{.spec.template.spec.containers[0].resources.limits.cpu}") === "300m", "cpu limit is not 300m"),
  });
  // rollout_undo and set_resource_limits each start a rollout; a pod picked mid-rollout can vanish before restart_pod
  kubectl(DEV, ["-n", NS, "rollout", "status", "deployment/fixture-deploy", "--timeout=60s"]);
  const victim = pod();
  await toolCase(c, S, "restart_pod", { namespace: NS, podName: victim, dryRun: false, ...cl }, [], {
    verify: () => eventually(() => !exists(DEV, `pod ${victim}`) || jsonpath(DEV, `pod ${victim}`, "{.metadata.deletionTimestamp}") !== "", `pod ${victim} was not deleted`),
  });
  await toolCase(c, S, "create_deployment", { namespace: NS, deploymentName: "e2e-created", image: "nginx:alpine", replicas: 1, port: 80, dryRun: false, ...cl }, [], {
    verify: () => assert(exists(DEV, "deployment e2e-created"), "deployment not created"),
  });
  await toolCase(c, S, "delete_deployment", { namespace: NS, deploymentName: "e2e-created", dryRun: false, ...cl }, [], {
    verify: () => eventually(() => !exists(DEV, "deployment e2e-created"), "deployment still exists"),
  });

  // Jobs
  await toolCase(c, S, "create_job", { namespace: NS, jobName: `e2e-job-${runId}`, image: "busybox", command: ["echo", "hi"], dryRun: false, ...cl }, [], {
    verify: () => assert(exists(DEV, `job e2e-job-${runId}`), "job not created"),
  });
  await toolCase(c, S, "suspend_cronjob", { namespace: NS, cronJobName: "fixture-cron", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, "cronjob fixture-cron", "{.spec.suspend}") === "true", "cronjob not suspended"),
  });
  await toolCase(c, S, "resume_cronjob", { namespace: NS, cronJobName: "fixture-cron", dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, "cronjob fixture-cron", "{.spec.suspend}") === "false", "cronjob still suspended"),
  });

  // Config management
  await toolCase(c, S, "create_configmap", { namespace: NS, configMapName: `e2e-cm-${runId}`, data: { A: "1" }, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, `configmap e2e-cm-${runId}`, "{.data.A}") === "1", "configmap missing or wrong data"),
  });
  await toolCase(c, S, "update_configmap", { namespace: NS, configMapName: `e2e-cm-${runId}`, data: { B: "2" }, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, `configmap e2e-cm-${runId}`, "{.data.B}") === "2", "configmap not updated"),
  });
  await toolCase(c, S, "create_secret", { namespace: NS, secretName: `e2e-secret-${runId}`, stringData: { TOKEN: "s3cr3t-value", USER: "app" }, dryRun: false, ...cl }, [(t) => (t.includes("s3cr3t-value") ? "secret value echoed in tool output" : undefined)], {
    verify: () => assert(Buffer.from(jsonpath(DEV, `secret e2e-secret-${runId}`, "{.data.TOKEN}"), "base64").toString() === "s3cr3t-value", "secret missing or wrong value"),
  });
  await toolCase(c, S, "update_secret", { namespace: NS, secretName: `e2e-secret-${runId}`, stringData: { TOKEN: "rotated-value" }, dryRun: false, ...cl }, [], {
    verify: () => {
      assert(Buffer.from(jsonpath(DEV, `secret e2e-secret-${runId}`, "{.data.TOKEN}"), "base64").toString() === "rotated-value", "secret not rotated");
      assert(Buffer.from(jsonpath(DEV, `secret e2e-secret-${runId}`, "{.data.USER}"), "base64").toString() === "app", "a key that was not passed was dropped");
    },
  });

  // Namespaces, autoscaling, networking
  await toolCase(c, S, "create_namespace", { namespaceName: `e2e-ns-${runId}`, dryRun: false, ...cl }, [], {
    verify: () => assert(exists(DEV, `namespace e2e-ns-${runId}`, null), "namespace not created"),
  });
  await toolCase(c, S, "delete_namespace", { namespaceName: `e2e-ns-${runId}`, dryRun: false, ...cl }, [], {
    verify: () => eventually(() => !exists(DEV, `namespace e2e-ns-${runId}`, null) || jsonpath(DEV, `namespace e2e-ns-${runId}`, "{.status.phase}", null) === "Terminating", "namespace not deleted"),
  });
  await toolCase(c, S, "create_horizontal_pod_autoscaler", { namespace: NS, hpaName: `e2e-hpa-${runId}`, targetDeployment: "fixture-deploy", minReplicas: 1, maxReplicas: 3, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, `hpa e2e-hpa-${runId}`, "{.spec.maxReplicas}") === "3", "HPA not created"),
  });
  await toolCase(c, S, "create_service", { namespace: NS, serviceName: `e2e-svc-${runId}`, port: 8080, targetPort: 80, selector: { app: "fixture-deploy" }, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, `service e2e-svc-${runId}`, "{.spec.ports[0].port}") === "8080", "service not created"),
  });
  await toolCase(c, S, "update_ingress", { namespace: NS, ingressName: "fixture-ingress", annotations: { "e2e/updated": "yes" }, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, "ingress fixture-ingress", "{.metadata.annotations.e2e/updated}") === "yes", "annotation not set"),
  });
  await toolCase(c, S, "create_network_policy", { namespace: NS, policyName: `e2e-np-${runId}`, podSelector: {}, policyTypes: ["Ingress"], dryRun: false, ...cl }, [], {
    verify: () => assert(exists(DEV, `networkpolicy e2e-np-${runId}`), "network policy not created"),
  });

  // Node administration on the dedicated drain node
  const node = "gke-dev-drain-1";
  await toolCase(c, S, "cordon_node", { nodeName: node, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, `node ${node}`, "{.spec.unschedulable}", null) === "true", "node not cordoned"),
  });
  await toolCase(c, S, "uncordon_node", { nodeName: node, dryRun: false, ...cl }, [], {
    verify: () => assert(jsonpath(DEV, `node ${node}`, "{.spec.unschedulable}", null) !== "true", "node still cordoned"),
  });
  kubectl(DEV, ["taint", "node", node, "existing=keep:PreferNoSchedule", "--overwrite"]);
  const taintKeys = () => jsonpath(DEV, `node ${node}`, "{.spec.taints[*].key}", null).split(" ");
  await toolCase(c, S, "taint_node", { nodeName: node, key: "e2e", value: "test", effect: "NoSchedule", dryRun: false, ...cl }, [], {
    label: "adds a taint and keeps existing ones",
    verify: () => {
      assert(taintKeys().includes("e2e"), "taint not added");
      assert(taintKeys().includes("existing"), "existing taint was removed");
    },
  });
  await toolCase(c, S, "remove_taint", { nodeName: node, key: "e2e", dryRun: false, ...cl }, [], {
    verify: () => {
      assert(!taintKeys().includes("e2e"), "taint still present");
      assert(taintKeys().includes("existing"), "unrelated taint was removed");
    },
  });
  kubectl(DEV, ["taint", "node", node, "existing-"]);
  await toolCase(c, S, "drain_node", { nodeName: node, ...cl }, [/DRY RUN/], { label: "defaults to dry run" });
  await toolCase(c, S, "drain_node", { nodeName: node, force: true, dryRun: false, ...cl }, [/Evicted [1-9]/], {
    label: "real (eviction API)",
    verify: () => eventually(() => !exists(DEV, "pod drain-victim") || jsonpath(DEV, "pod drain-victim", "{.metadata.deletionTimestamp}") !== "", "drain-victim was not evicted"),
  });

  // Multi-cluster tools from this client
  await toolCase(c, S, "list_clusters", {}, [/kwok-dev/, /kwok-prod/]);
  await toolCase(c, S, "get_cluster_info", cl, [/"platform": "gke"/, /v1\.33/]);
  await toolCase(c, S, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "test-app", clusterA: DEV, clusterB: PROD }, [/"driftDetected": true/]);

  await c.close();

  const missing = registered.filter(t => !coveredTools.has(t));
  await scenario(S, `coverage: all ${registered.length} registered tools exercised`, async () => {
    assert(!missing.length, `not exercised: ${missing.join(", ")}`);
    return `${coveredTools.size} tools exercised`;
  });
}

// ── Suite: multi-cluster behaviour over kubeconfig contexts ───────────────────

async function multiclusterSuite() {
  const S = "multicluster";
  const c = await stdioClient();

  await toolCase(c, S, "list_clusters", {}, [(t) => {
    const list = json(t);
    const names = list.map((x: any) => x.name).sort().join(",");
    if (names !== [DEV, PROD].sort().join(",")) return `clusters were ${names}`;
  }], { label: "every kubeconfig context is a cluster" });
  await toolCase(c, S, "get_cluster_info", { cluster: PROD }, [/"platform": "eks"/], { label: "detects EKS from node labels" });
  await toolCase(c, S, "list_nodes", { cluster: PROD }, [/ip-10-0-a-1/, (t) => (t.includes("gke-dev") ? "prod listing contains dev nodes" : undefined)], { label: "routes to prod" });
  await toolCase(c, S, "list_nodes", { cluster: DEV }, [/gke-dev-a-1/, (t) => (t.includes("ip-10-0") ? "dev listing contains prod nodes" : undefined)], { label: "routes to dev" });
  await toolCase(c, S, "list_node_pools", { cluster: PROD }, [/ng-general/, /ng-spot/, /"eks"/], { label: "EKS node groups" });
  await toolCase(c, S, "get_node_pool_detail", { poolName: "ng-spot", cluster: PROD }, [/"spot": true/], { label: "EKS spot capacity" });
  await toolCase(c, S, "get_workload_identity_config", { namespace: NS, serviceAccountName: "wi-sa", cluster: PROD }, [/arn:aws:iam::111122223333:role\/app/], { label: "IRSA role on EKS" });
  await toolCase(c, S, "get_storage_class", { storageClassName: "standard-rwo", cluster: PROD }, [/ebs\.csi\.aws\.com/], { label: "EBS CSI on EKS" });
  await toolCase(c, S, "get_gitops_app_status", { engine: "argocd", namespace: "argocd", appName: "test-app", cluster: PROD }, [/e5f6a7b8/], { label: "prod revision" });
  await toolCase(c, S, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "test-app", clusterA: DEV, clusterB: PROD }, [/"driftDetected": true/, /a1b2c3d4/, /e5f6a7b8/], { label: "drift detected" });

  kubectl(PROD, ["-n", "argocd", "patch", "application", "test-app", "--type=merge", "-p", '{"status":{"sync":{"revision":"a1b2c3d4"}}}']);
  await toolCase(c, S, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "test-app", clusterA: DEV, clusterB: PROD }, [/"driftDetected": false/], { label: "no drift once revisions match" });
  kubectl(PROD, ["-n", "argocd", "patch", "application", "test-app", "--type=merge", "-p", '{"status":{"sync":{"revision":"e5f6a7b8"}}}']);

  const before = jsonpath(PROD, "deployment fixture-deploy", "{.spec.replicas}");
  const devBefore = jsonpath(DEV, "deployment fixture-deploy", "{.spec.replicas}");
  await toolCase(c, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 5, dryRun: false }, [/'cluster' must be specified explicitly/], {
    label: "write without cluster is refused", expectError: true,
    verify: () => {
      assert(jsonpath(PROD, "deployment fixture-deploy", "{.spec.replicas}") === before, "prod replicas changed");
      assert(jsonpath(DEV, "deployment fixture-deploy", "{.spec.replicas}") === devBefore, "dev replicas changed");
    },
  });
  await toolCase(c, S, "list_pods", { namespace: NS }, [/fixture-deploy/], { label: "reads fall back to the current context" });
  await toolCase(c, S, "list_pods", { namespace: NS, cluster: "staging" }, [/Unknown cluster 'staging'/], { label: "unknown cluster rejected", expectError: true });
  await toolCase(c, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 3, dryRun: false, cluster: PROD }, [], {
    label: "write lands only on the named cluster",
    verify: () => {
      assert(jsonpath(PROD, "deployment fixture-deploy", "{.spec.replicas}") === "3", "prod not scaled");
      assert(jsonpath(DEV, "deployment fixture-deploy", "{.spec.replicas}") === devBefore, "dev was scaled too");
    },
  });
  await c.close();

  // Concurrent calls to both clusters share one client per cluster and stay isolated
  const c2 = await stdioClient();
  await scenario(S, "20 concurrent calls across both clusters", async () => {
    const calls = Array.from({ length: 20 }, (_, i) => call(c2, "list_nodes", { cluster: i % 2 ? PROD : DEV }));
    const outs = await Promise.all(calls);
    outs.forEach((o, i) => {
      assert(o.ok, `call ${i} failed: ${o.text}`);
      assert(o.text.includes(i % 2 ? "ip-10-0" : "gke-dev"), `call ${i} returned the wrong cluster`);
    });
    const ms = outs.map(o => o.ms).sort((a, b) => a - b);
    return `p50 ${ms[10]}ms, max ${ms[19]}ms`;
  });
  await c2.close();

  // Read-only local session
  const ro = await stdioClient({ K8SCORTEX_STDIO_ROLES: "developer" });
  await toolCase(ro, S, "list_pods", { namespace: NS, cluster: DEV }, [/fixture-deploy/], { label: "K8SCORTEX_STDIO_ROLES=developer can read" });
  await toolCase(ro, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 1, cluster: DEV }, [/Unauthorized/], { label: "K8SCORTEX_STDIO_ROLES=developer cannot write", expectError: true });
  await ro.close();
}

// ── Suite: CLUSTERS_CONFIG registry with policies (stdio) ─────────────────────

function writeRegistry(): string {
  const path = join(WORK, "clusters.json");
  writeFileSync(path, JSON.stringify({
    defaultCluster: "dev",
    clusters: [
      { name: "dev", provider: "kubeconfig", context: DEV, cloud: "gke", region: "us-central1", labels: { env: "dev" } },
      { name: "prod", provider: "kubeconfig", context: PROD, cloud: "eks", region: "us-east-1", labels: { env: "prod", tier: "restricted" } },
    ],
    policies: [
      { labels: { env: "prod" }, minRole: "sre", appliesTo: "mutating" },
      { labels: { tier: "restricted" }, minRole: "team-lead" },
      { match: "prod", denyTools: ["drain_node", "delete_namespace"] },
    ],
  }, null, 2));
  return path;
}

async function registrySuite() {
  const S = "registry";
  const config = writeRegistry();

  const pe = await stdioClient({ CLUSTERS_CONFIG: config });
  await toolCase(pe, S, "list_clusters", {}, [(t) => {
    const names = json(t).map((x: any) => `${x.name}:${x.cloud}:${x.region}`).join(",");
    if (names !== "dev:gke:us-central1,prod:eks:us-east-1") return `got ${names}`;
  }], { label: "named clusters with metadata" });
  await toolCase(pe, S, "list_clusters", { labelSelector: "env=prod" }, [/"prod"/, (t) => (json(t).length === 1 ? undefined : "filter returned more than one cluster")], { label: "label filter" });
  await toolCase(pe, S, "list_clusters", { cloud: "gke" }, [/"dev"/, (t) => (json(t).length === 1 ? undefined : "filter returned more than one cluster")], { label: "cloud filter" });
  await toolCase(pe, S, "list_nodes", {}, [/gke-dev/], { label: "defaultCluster used for reads" });
  await toolCase(pe, S, "list_nodes", { cluster: "prod" }, [/ip-10-0/], { label: "registry name routes to its context" });
  await toolCase(pe, S, "drain_node", { nodeName: "ip-10-0-a-1", cluster: "prod" }, [/disabled on cluster 'prod' by policy/], { label: "denyTools blocks even platform-engineer", expectError: true });
  await toolCase(pe, S, "drain_node", { nodeName: "gke-dev-a-1", cluster: "dev" }, [/DRY RUN/], { label: "same tool allowed on dev" });
  await pe.close();

  const rm = await stdioClient({ CLUSTERS_CONFIG: config, K8SCORTEX_STDIO_ROLES: "release-manager" });
  await toolCase(rm, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 2, cluster: "prod" }, [/requires role sre/], { label: "release-manager blocked from prod writes", expectError: true });
  await toolCase(rm, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 2, cluster: "dev" }, [/DRY RUN/], { label: "release-manager can write to dev" });
  await toolCase(rm, S, "list_pods", { namespace: NS, cluster: "prod" }, [/fixture-deploy/], { label: "release-manager can read prod" });
  await rm.close();

  const dev = await stdioClient({ CLUSTERS_CONFIG: config, K8SCORTEX_STDIO_ROLES: "developer" });
  await toolCase(dev, S, "list_pods", { namespace: NS, cluster: "prod" }, [/requires role team-lead/], { label: "developer blocked from restricted prod", expectError: true });
  await toolCase(dev, S, "compare_clusters", { engine: "argocd", namespace: "argocd", appName: "test-app", clusterA: "dev", clusterB: "prod" }, [/requires role team-lead/], { label: "compare_clusters checks both clusters", expectError: true });
  await dev.close();

  const sre = await stdioClient({ CLUSTERS_CONFIG: config, K8SCORTEX_STDIO_ROLES: "sre" });
  await toolCase(sre, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 2, cluster: "prod" }, [/DRY RUN/], { label: "sre can write to prod" });
  await sre.close();
}

// ── Suite: HTTP transports with a local OIDC issuer ───────────────────────────

interface Issuer { url: string; sign(claims: object, opts?: jwt.SignOptions): string; close(): void }

async function startIssuer(): Promise<Issuer> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e", use: "sig", alg: "RS256" };
  let url = "";
  const server: HttpServer = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/openid-configuration") res.end(JSON.stringify({ issuer: url, jwks_uri: `${url}/keys` }));
    else if (req.url === "/keys") res.end(JSON.stringify({ keys: [jwk] }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    sign: (claims, opts = {}) => jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: "e2e", issuer: url, audience: "k8scortex", expiresIn: "10m", ...opts }),
    close: () => server.close(),
  };
}

async function startHttpServer(env: Record<string, string>, port: number): Promise<{ proc: ChildProcess; base: string; stderr: () => string }> {
  let stderr = "";
  const proc = spawn("node", [join(ROOT, "dist/index.js")], { env: { ...process.env as Record<string, string>, PORT: String(port), ...env }, stdio: "pipe" });
  proc.stderr?.on("data", d => { stderr += d; });
  proc.stdout?.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/health`)).ok) return { proc, base, stderr: () => stderr }; } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`server did not start: ${stderr}`);
}

async function httpClient(base: string, token: string, kind: "streamable" | "sse"): Promise<Client> {
  const headers = { Authorization: `Bearer ${token}` };
  const transport = kind === "sse"
    ? new SSEClientTransport(new URL(`${base}/mcp`), { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as any), ...headers } }) } })
    : new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "kwok-e2e-http", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

const ROLE_GROUPS: Record<string, string> = {
  developer: "k8s-developers",
  "team-lead": "k8s-leads",
  "release-manager": "k8s-release",
  sre: "k8s-sre",
  "platform-engineer": "k8s-platform",
  "ci-pipeline": "k8s-ci",
};

async function httpSuite() {
  const S = "http-auth";
  const issuer = await startIssuer();
  const auditFile = join(WORK, "http-audit.log");
  const server = await startHttpServer({
    OIDC_ISSUER: issuer.url,
    OIDC_AUDIENCE: "k8scortex",
    OIDC_ROLES_CLAIM: "groups",
    OIDC_ROLE_MAP: JSON.stringify(Object.fromEntries(Object.entries(ROLE_GROUPS).map(([role, group]) => [group, role]))),
    CLUSTERS_CONFIG: writeRegistry(),
    AUDIT_LOG_FILE: auditFile,
  }, 3411);
  const token = (role: string, sub = `user-${role}`) => issuer.sign({ sub, groups: [ROLE_GROUPS[role]] });

  try {
    // Role matrix: one representative tool per tier, on the unrestricted dev cluster
    const tiers: Array<[string, Record<string, unknown>, string]> = [
      ["list_pods", { namespace: NS, cluster: "dev" }, "developer"],
      ["get_configmap", { namespace: NS, configMapName: "fixture-config", cluster: "dev" }, "team-lead"],
      ["scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 2, cluster: "dev" }, "release-manager"],
      ["create_secret", { namespace: NS, secretName: "rbac-probe", stringData: { k: "v" }, cluster: "dev" }, "sre"],
      ["drain_node", { nodeName: "gke-dev-a-1", cluster: "dev" }, "platform-engineer"],
    ];
    const order = ["developer", "team-lead", "release-manager", "sre", "platform-engineer"];
    for (const role of [...order, "ci-pipeline"]) {
      const client = await httpClient(server.base, token(role), role === "sre" ? "sse" : "streamable");
      for (const [tool, args, minRole] of tiers) {
        const allowed = role !== "ci-pipeline" && order.indexOf(role) >= order.indexOf(minRole);
        await toolCase(client, S, tool, args, allowed ? [] : [/Unauthorized/], {
          label: `${role} ${allowed ? "allowed" : "denied"} (${role === "sre" ? "SSE" : "StreamableHTTP"})`,
          expectError: !allowed,
        });
      }
      await client.close();
    }

    const ci = await httpClient(server.base, token("ci-pipeline"), "streamable");
    await toolCase(ci, S, "describe_deployment", { namespace: NS, deploymentName: "fixture-deploy", cluster: "dev" }, [/fixture-deploy/], { label: "ci-pipeline scoped allow" });
    await ci.close();

    // Policies apply over HTTP too
    const rm = await httpClient(server.base, token("release-manager"), "streamable");
    await toolCase(rm, S, "scale_deployment", { namespace: NS, deploymentName: "fixture-deploy", replicas: 2, cluster: "prod" }, [/requires role sre/], { label: "policy: release-manager blocked on prod", expectError: true });
    await rm.close();

    // Generic read guards depend on the caller's role
    const devClient = await httpClient(server.base, token("developer"), "streamable");
    await toolCase(devClient, S, "get_k8s_resource", { version: "v1", resource: "configmaps", name: "fixture-config", namespace: NS, cluster: "dev" }, [/requires the same role as get_configmap/], { label: "developer cannot read configmaps via generic read", expectError: true });
    await toolCase(devClient, S, "get_k8s_resource", { version: "v1", resource: "secrets", name: "fixture-secret", namespace: NS, cluster: "dev" }, [/not permitted/, (t) => (t.includes("do-not-leak") ? "secret value leaked" : undefined)], { label: "secrets blocked via generic read", expectError: true });
    await devClient.close();
    const lead = await httpClient(server.base, token("team-lead"), "streamable");
    await toolCase(lead, S, "get_k8s_resource", { version: "v1", resource: "configmaps", name: "fixture-config", namespace: NS, cluster: "dev" }, [/LOG_LEVEL/], { label: "team-lead can read configmaps via generic read" });
    await lead.close();

    // Token validation
    const post = (tok: string | undefined, extra: Record<string, string> = {}) => fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } } }),
    });
    await scenario(S, "missing token → 401", async () => { assert((await post(undefined)).status === 401, "expected 401"); });
    await scenario(S, "wrong audience → 403", async () => { assert((await post(issuer.sign({ sub: "x", groups: ["k8s-platform"] }, { audience: "other" }))).status === 403, "expected 403"); });
    await scenario(S, "wrong issuer → 403", async () => { assert((await post(issuer.sign({ sub: "x" }, { issuer: "https://evil.example.com" }))).status === 403, "expected 403"); });
    await scenario(S, "expired token → 403", async () => { assert((await post(issuer.sign({ sub: "x" }, { expiresIn: "-10s" }))).status === 403, "expected 403"); });
    await scenario(S, "HS256 token signed with a guessed secret → 403", async () => {
      assert((await post(jwt.sign({ sub: "x", groups: ["k8s-platform"] }, "secret", { issuer: issuer.url, audience: "k8scortex" }))).status === 403, "expected 403");
    });
    await scenario(S, "unknown IdP group grants nothing", async () => {
      const c = await httpClient(server.base, issuer.sign({ sub: "nobody", groups: ["random-group"] }), "streamable");
      const out = await call(c, "list_pods", { namespace: NS, cluster: "dev" });
      await c.close();
      assert(!out.ok && /Unauthorized/.test(out.text), `expected denial, got: ${out.text.slice(0, 120)}`);
    });

    // Session isolation
    await scenario(S, "StreamableHTTP session cannot be reused by another user", async () => {
      const init = await post(token("developer", "alice"));
      const sid = init.headers.get("mcp-session-id");
      await init.body?.cancel();
      assert(sid, "no session id");
      const hijack = await fetch(`${server.base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token("platform-engineer", "mallory")}`, "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      assert(hijack.status === 403, `expected 403, got ${hijack.status}`);
    });
    await scenario(S, "concurrent SSE + StreamableHTTP clients keep their identities", async () => {
      const a = await httpClient(server.base, token("developer", "carol"), "sse");
      const b = await httpClient(server.base, token("platform-engineer", "dave"), "streamable");
      const [ra, rb] = await Promise.all([
        call(a, "drain_node", { nodeName: "gke-dev-a-1", cluster: "dev" }),
        call(b, "drain_node", { nodeName: "gke-dev-a-1", cluster: "dev" }),
      ]);
      await a.close(); await b.close();
      assert(!ra.ok && /Unauthorized/.test(ra.text), "developer's drain was not denied");
      assert(rb.ok && /DRY RUN/.test(rb.text), `platform-engineer's drain failed: ${rb.text}`);
    });

    // Audit content
    const secretClient = await httpClient(server.base, token("sre", "erin"), "streamable");
    await call(secretClient, "create_secret", { namespace: NS, secretName: "audit-probe", stringData: { API_KEY: "audit-must-not-see-this" }, dryRun: false, cluster: "dev" });
    await secretClient.close();
    await new Promise(r => setTimeout(r, 300));
    const audit = readFileSync(auditFile, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    await scenario("audit", "secret values are redacted", async () => {
      assert(!readFileSync(auditFile, "utf-8").includes("audit-must-not-see-this"), "secret value present in audit log");
      const entry = audit.filter(e => e.tool === "create_secret" && e.userOid === "erin").at(-1);
      assert(entry?.arguments?.stringData === "[REDACTED]", "stringData not redacted");
      assert(entry?.arguments?.secretName === "audit-probe", "secretName should remain visible");
    });
    await scenario("audit", "records carry identity, resolved cluster and provider", async () => {
      const entry = audit.filter(e => e.tool === "list_pods" && e.userOid === "user-developer" && e.status === "success").at(-1);
      assert(entry, "no successful list_pods entry for user-developer");
      assert(entry.arguments._cluster === "dev" && entry.arguments._provider === "kubeconfig", `got ${JSON.stringify(entry.arguments)}`);
    });
    await scenario("audit", "denials are recorded with reason", async () => {
      const entry = audit.find(e => e.tool === "scale_deployment" && e.userOid === "user-release-manager" && e.status === "denied");
      assert(entry && /requires role sre/.test(entry.errorMessage), "no policy denial entry");
    });
    await scenario("audit", "every tool call produced an audit record", async () => {
      return `${audit.length} records`;
    });
  } finally {
    server.proc.kill();
    issuer.close();
  }
}

// ── Suite: startup configuration errors ───────────────────────────────────────

async function startupSuite() {
  const S = "startup";
  const exitOf = (env: Record<string, string>, entry = "dist/index.js") => new Promise<{ code: number | null; stderr: string }>((res) => {
    const base = { ...process.env as Record<string, string> };
    for (const k of ["TEST_JWT_SECRET", "OIDC_ISSUER", "OIDC_AUDIENCE", "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "DISABLE_AUTH"]) delete base[k];
    const p = spawn("node", [join(ROOT, entry)], { env: { ...base, PORT: "3412", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    p.stderr?.on("data", d => { stderr += d; });
    p.stdout?.on("data", d => { stderr += d; });
    const timer = setTimeout(() => p.kill(), 8000);
    p.on("exit", (code) => { clearTimeout(timer); res({ code, stderr }); });
  });

  await scenario(S, "HTTP mode without an identity provider refuses to start", async () => {
    const r = await exitOf({});
    assert(r.code === 1 && /OIDC_ISSUER/.test(r.stderr), `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
  });
  await scenario(S, "invalid CLUSTERS_CONFIG refuses to start (HTTP)", async () => {
    const bad = join(WORK, "bad.json");
    writeFileSync(bad, JSON.stringify({ clusters: [{ name: "a", provider: "rancher" }] }));
    const r = await exitOf({ DISABLE_AUTH: "true", CLUSTERS_CONFIG: bad });
    assert(r.code === 1 && /unknown provider/.test(r.stderr), `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
  });
  await scenario(S, "invalid CLUSTERS_CONFIG refuses to start (stdio)", async () => {
    const bad = join(WORK, "bad2.json");
    writeFileSync(bad, JSON.stringify({ defaultCluster: "zzz", clusters: [{ name: "a" }] }));
    const r = await exitOf({ CLUSTERS_CONFIG: bad }, "dist/stdio.js");
    assert(r.code === 1 && /defaultCluster 'zzz'/.test(r.stderr), `exit ${r.code}: ${r.stderr.slice(0, 200)}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  assert(existsSync(join(ROOT, "dist/index.js")), "run `npm run build` first");
  const started = Date.now();
  const only = process.env.SUITES?.split(",");
  const suites: Array<[string, () => Promise<void>]> = [
    ["tools", toolsSuite], ["multicluster", multiclusterSuite], ["registry", registrySuite], ["http-auth", httpSuite], ["startup", startupSuite],
  ];
  for (const [name, fn] of suites) {
    if (only && !only.includes(name)) continue;
    console.log(`\n── ${name} ──`);
    try { await fn(); } catch (err: any) { record({ suite: name, name: "suite crashed", status: "FAIL", ms: 0, detail: err.stack || err.message }); }
  }

  const failed = results.filter(r => r.status === "FAIL");
  const summary = {
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    environment: {
      kubernetes: kubectl(DEV, ["version", "-o", "json"]).match(/"gitVersion":\s*"([^"]+)"/g)?.at(-1)?.split('"')[3],
      clusters: { [DEV]: "KWOK, GKE-like node labels", [PROD]: "KWOK, EKS-like node labels" },
      node: process.version,
    },
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    toolsExercised: coveredTools.size,
    results,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(summary, null, 2));
  console.log(`\nTOTAL=${summary.total} PASS=${summary.passed} FAIL=${summary.failed} TOOLS=${summary.toolsExercised} → ${RESULTS_FILE}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
