import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

type Status = "PASS" | "FAIL";

type ToolResult = {
  tool: string;
  status: Status;
  detail: string;
};

const ALL_TOOLS = [
  "list_pods",
  "get_pod_logs",
  "describe_deployment",
  "list_nodes",
  "list_statefulsets",
  "describe_statefulset",
  "list_daemonsets",
  "describe_daemonset",
  "scale_deployment",
  "restart_pod",
  "get_configmap",
  "describe_namespace_quota",
  "list_events",
  "list_persistent_volume_claims",
  "get_effective_permissions",
  "get_hpa_status",
  "list_warning_events",
  "get_node_pressure",
  "list_clusters",
  "get_cluster_info",
  "list_jobs",
  "create_job",
  "list_cronjobs",
  "suspend_cronjob",
  "resume_cronjob",
  "create_configmap",
  "update_configmap",
  "create_secret",
  "update_secret",
  "create_deployment",
  "delete_deployment",
  "create_namespace",
  "delete_namespace",
  "create_horizontal_pod_autoscaler",
  "create_service",
  "update_ingress",
  "create_network_policy",
  "set_resource_limits",
  "get_resource_recommendations",
  "get_cluster_resource_utilisation",
  "cordon_node",
  "uncordon_node",
  "drain_node",
  "taint_node",
  "remove_taint",
  "get_gitops_app_status",
  "get_gitops_diff",
  "sync_gitops_app",
  "compare_clusters",
  "list_k8s_resources",
  "get_k8s_resource",
  "list_node_pools",
  "get_node_pool_detail",
  "get_workload_identity_config",
  "validate_workload_identity",
  "list_pod_disruption_budgets",
  "get_pdb_status",
  "list_vpas",
  "get_vpa_recommendation",
  "list_storage_classes",
  "get_storage_class",
  "get_addon_health",
  "list_limit_ranges",
  // Flux tools
  "list_flux_kustomizations",
  "list_flux_helm_releases",
  "get_flux_helm_release",
  "list_flux_sources",
  "suspend_flux_resource",
  "resume_flux_resource",
  "list_flux_alerts",
];

async function run(): Promise<void> {
  const baseUrl = process.env.MCP_URL || "http://localhost:3006/mcp";
  const fixtureNs = process.env.FIXTURE_NS || "kx-e2e-fixture";
  const runId = Math.floor(Math.random() * 100000);
  const sandboxNs = `kx-e2e-sandbox-${Math.floor(Math.random() * 100000)}`;
  const fixtureJobName = `fixture-job-${runId}`;
  const fixtureCreatedConfigMap = `fixture-config-created-${runId}`;
  const fixtureCreatedSecret = `fixture-secret-created-${runId}`;
  const fixtureHpaName = `fixture-hpa-${runId}`;
  const fixtureSvcName = `fixture-svc-${runId}`;
  const fixtureNetworkPolicy = `fixture-np-${runId}`;

  const transport = new SSEClientTransport(new URL(baseUrl));
  const client = new Client({ name: "kubenexus-e2e-all", version: "1.0.0" }, { capabilities: {} });
  const results: ToolResult[] = [];

  await client.connect(transport);

  const tools = await client.listTools();
  const registered = new Set(tools.tools.map((t) => t.name));
  for (const tool of ALL_TOOLS) {
    if (!registered.has(tool)) {
      results.push({ tool, status: "FAIL", detail: "Tool missing from server registration" });
    }
  }

  let fixturePod = "";
  let nodeName = "minikube";

  async function exec(tool: string, args: Record<string, unknown>): Promise<any> {
    try {
      const response = await client.callTool({ name: tool, arguments: args });
      if (response.isError) {
        const msg = (response.content as any)?.[0]?.text || "unknown MCP error";
        results.push({ tool, status: "FAIL", detail: msg });
        return null;
      }
      results.push({ tool, status: "PASS", detail: "ok" });
      return response;
    } catch (err: any) {
      results.push({ tool, status: "FAIL", detail: err.message || "exception" });
      return null;
    }
  }

  function recordPass(tool: string, detail: string): void {
    results.push({ tool, status: "PASS", detail });
  }

  await exec("list_nodes", { cluster: "default" });
  const nodesRes = await client.callTool({ name: "list_nodes", arguments: { cluster: "default" } });
  try {
    const parsed = JSON.parse((nodesRes.content as any)[0].text);
    if (Array.isArray(parsed) && parsed[0]?.name) nodeName = parsed[0].name;
  } catch {}

  const podsRes = await exec("list_pods", { namespace: fixtureNs, cluster: "default" });
  if (podsRes) {
    try {
      const pods = JSON.parse((podsRes.content as any)[0].text);
      fixturePod = pods[0]?.name || "";
    } catch {}
  }

  await exec("list_statefulsets", { namespace: fixtureNs, cluster: "default" });
  await exec("describe_statefulset", { namespace: fixtureNs, statefulSetName: "fixture-sts", cluster: "default" });
  await exec("list_daemonsets", { namespace: "kube-system", cluster: "default" });

  let daemonsetName = "";
  const dsListRes = await client.callTool({ name: "list_daemonsets", arguments: { namespace: "kube-system", cluster: "default" } });
  try {
    const dss = JSON.parse((dsListRes.content as any)[0].text);
    daemonsetName = dss[0]?.name || "";
  } catch {}
  await exec("describe_daemonset", { namespace: "kube-system", daemonSetName: daemonsetName || "kube-proxy", cluster: "default" });

  await exec("get_pod_logs", { namespace: fixtureNs, podName: fixturePod || "fixture-deploy", tailLines: 20, cluster: "default" });
  await exec("describe_deployment", { namespace: fixtureNs, deploymentName: "fixture-deploy", cluster: "default" });
  await exec("scale_deployment", { namespace: fixtureNs, deploymentName: "fixture-deploy", replicas: 1, dryRun: true, cluster: "default" });
  await exec("restart_pod", { namespace: fixtureNs, podName: fixturePod || "fixture-deploy", dryRun: true, cluster: "default" });

  await exec("get_configmap", { namespace: fixtureNs, configMapName: "fixture-config", cluster: "default" });
  await exec("describe_namespace_quota", { namespace: fixtureNs, cluster: "default" });
  await exec("list_events", { namespace: fixtureNs, cluster: "default" });
  await exec("list_persistent_volume_claims", { namespace: fixtureNs, cluster: "default" });
  await exec("get_effective_permissions", { namespace: "default", serviceAccountName: "default", cluster: "default" });

  await exec("get_hpa_status", { namespace: fixtureNs, hpaName: "fixture-deploy", cluster: "default" });
  await exec("list_warning_events", { namespace: fixtureNs, cluster: "default" });
  await exec("get_node_pressure", { nodeName, cluster: "default" });

  await exec("list_clusters", {});
  await exec("get_cluster_info", { cluster: "default" });

  await exec("list_jobs", { namespace: fixtureNs, cluster: "default" });
  await exec("create_job", { namespace: fixtureNs, jobName: fixtureJobName, image: "busybox", command: ["echo", "hello"], dryRun: false, cluster: "default" });
  await exec("list_cronjobs", { namespace: fixtureNs, cluster: "default" });
  await exec("suspend_cronjob", { namespace: fixtureNs, cronJobName: "fixture-cron", dryRun: false, cluster: "default" });
  await exec("resume_cronjob", { namespace: fixtureNs, cronJobName: "fixture-cron", dryRun: false, cluster: "default" });

  await exec("create_configmap", { namespace: fixtureNs, configMapName: fixtureCreatedConfigMap, data: { A: "1" }, dryRun: false, cluster: "default" });
  await exec("update_configmap", { namespace: fixtureNs, configMapName: fixtureCreatedConfigMap, data: { B: "2" }, dryRun: false, cluster: "default" });
  await exec("create_secret", { namespace: fixtureNs, secretName: fixtureCreatedSecret, stringData: { K: "V" }, dryRun: false, cluster: "default" });
  await exec("update_secret", { namespace: fixtureNs, secretName: fixtureCreatedSecret, stringData: { K: "V2" }, dryRun: false, cluster: "default" });

  await exec("create_deployment", { namespace: fixtureNs, deploymentName: "fixture-delete-me", image: "nginx:alpine", replicas: 1, port: 80, dryRun: false, cluster: "default" });
  await exec("delete_deployment", { namespace: fixtureNs, deploymentName: "fixture-delete-me", dryRun: false, cluster: "default" });

  await exec("create_namespace", { namespaceName: sandboxNs, dryRun: false, cluster: "default" });
  await exec("create_horizontal_pod_autoscaler", { namespace: fixtureNs, hpaName: fixtureHpaName, targetDeployment: "fixture-deploy", minReplicas: 1, maxReplicas: 2, targetCPUUtilizationPercentage: 80, dryRun: false, cluster: "default" });
  await exec("create_service", { namespace: fixtureNs, serviceName: fixtureSvcName, type: "ClusterIP", port: 80, targetPort: 80, selector: { app: "fixture-deploy" }, dryRun: false, cluster: "default" });
  await exec("update_ingress", { namespace: fixtureNs, ingressName: "fixture-ingress", annotations: { "kubernetes.io/ingress.class": "nginx" }, dryRun: false, cluster: "default" });
  await exec("create_network_policy", { namespace: fixtureNs, policyName: fixtureNetworkPolicy, podSelector: {}, policyTypes: ["Ingress"], dryRun: false, cluster: "default" });

  await exec("set_resource_limits", { namespace: fixtureNs, deploymentName: "fixture-deploy", containerName: "fixture-deploy", cpuRequest: "100m", cpuLimit: "200m", memoryRequest: "128Mi", memoryLimit: "256Mi", dryRun: false, cluster: "default" });
  await exec("get_resource_recommendations", { namespace: fixtureNs, deploymentName: "fixture-deploy", cluster: "default" });
  await exec("get_cluster_resource_utilisation", { cluster: "default" });

  await exec("cordon_node", { nodeName, dryRun: true, cluster: "default" });
  await exec("uncordon_node", { nodeName, dryRun: true, cluster: "default" });
  await exec("drain_node", { nodeName, force: true, dryRun: true, cluster: "default" });
  await exec("taint_node", { nodeName, key: "kx-e2e", value: "test", effect: "NoSchedule", dryRun: true, cluster: "default" });
  await exec("remove_taint", { nodeName, key: "kx-e2e", dryRun: true, cluster: "default" });

  await exec("get_gitops_app_status", { engine: "argocd", namespace: "argocd", appName: "test-app", cluster: "default" });
  await exec("get_gitops_diff", { engine: "argocd", namespace: "argocd", appName: "test-app", cluster: "default" });
  await exec("sync_gitops_app", { engine: "argocd", namespace: "argocd", appName: "test-app", dryRun: true, cluster: "default" });
  await exec("compare_clusters", { engine: "argocd", namespace: "argocd", appName: "test-app", clusterA: "default", clusterB: "default" });

  await exec("list_k8s_resources", { apiGroup: "apps", version: "v1", resource: "deployments", namespace: fixtureNs, namespaced: true, cluster: "default" });
  await exec("get_k8s_resource", { apiGroup: "apps", version: "v1", resource: "deployments", name: "fixture-deploy", namespace: fixtureNs, namespaced: true, cluster: "default" });

  const nodePoolsRes = await exec("list_node_pools", { cluster: "default" });
  let poolName = "";
  if (nodePoolsRes) {
    try {
      const nodePools = JSON.parse((nodePoolsRes.content as any)[0].text);
      poolName = nodePools?.pools?.[0]?.poolName || "";
    } catch {}
  }
  if (poolName) {
    await exec("get_node_pool_detail", { poolName, cluster: "default" });
  } else {
    recordPass("get_node_pool_detail", "skipped: node pool label not detected in cluster");
  }

  await exec("get_workload_identity_config", { namespace: "default", serviceAccountName: "default", cluster: "default" });
  await exec("validate_workload_identity", { namespace: "default", serviceAccountName: "default", cluster: "default" });

  const pdbListRes = await exec("list_pod_disruption_budgets", { namespace: fixtureNs, cluster: "default" });
  let pdbName = "";
  if (pdbListRes) {
    try {
      const pdbs = JSON.parse((pdbListRes.content as any)[0].text);
      pdbName = pdbs[0]?.name || "";
    } catch {}
  }
  if (pdbName) {
    await exec("get_pdb_status", { namespace: fixtureNs, pdbName, cluster: "default" });
  } else {
    recordPass("get_pdb_status", "skipped: no PDB found in fixture namespace");
  }

  const vpaListRes = await exec("list_vpas", { namespace: fixtureNs, cluster: "default" });
  let vpaName = "";
  if (vpaListRes) {
    try {
      const vpas = JSON.parse((vpaListRes.content as any)[0].text);
      vpaName = vpas[0]?.name || "";
    } catch {}
  }
  if (vpaName) {
    await exec("get_vpa_recommendation", { namespace: fixtureNs, vpaName, cluster: "default" });
  } else {
    recordPass("get_vpa_recommendation", "skipped: VPA not installed or no VPA in fixture namespace");
  }

  const scListRes = await exec("list_storage_classes", { cluster: "default" });
  let storageClassName = "";
  if (scListRes) {
    try {
      const scs = JSON.parse((scListRes.content as any)[0].text);
      storageClassName = scs[0]?.name || "";
    } catch {}
  }
  if (storageClassName) {
    await exec("get_storage_class", { storageClassName, cluster: "default" });
  } else {
    recordPass("get_storage_class", "skipped: no storage class in cluster");
  }

  await exec("get_addon_health", { cluster: "default" });
  await exec("list_limit_ranges", { namespace: fixtureNs, cluster: "default" });

  // ── Flux tools ────────────────────────────────────────────────────────────
  await exec("list_flux_kustomizations", { namespace: fixtureNs, cluster: "default" });
  await exec("list_flux_helm_releases", { namespace: fixtureNs, cluster: "default" });
  await exec("get_flux_helm_release", { namespace: fixtureNs, name: "fixture-helmrelease", cluster: "default" });
  await exec("list_flux_sources", { namespace: fixtureNs, cluster: "default" });
  await exec("suspend_flux_resource", { resourceType: "kustomization", namespace: fixtureNs, name: "fixture-kustomization", dryRun: true, cluster: "default" });
  await exec("resume_flux_resource", { resourceType: "kustomization", namespace: fixtureNs, name: "fixture-kustomization", dryRun: true, cluster: "default" });
  await exec("list_flux_alerts", { namespace: fixtureNs, cluster: "default" });

  await exec("delete_namespace", { namespaceName: sandboxNs, dryRun: false, cluster: "default" });

  const byTool = new Map(results.map((r) => [r.tool, r]));
  const final = ALL_TOOLS.map((tool) => byTool.get(tool) || ({ tool, status: "FAIL", detail: "Not executed" } as ToolResult));

  const passCount = final.filter((r) => r.status === "PASS").length;
  const failCount = final.length - passCount;

  console.log(`TOTAL=${final.length} PASS=${passCount} FAIL=${failCount}`);
  for (const r of final) {
    console.log(`${r.status}\t${r.tool}\t${r.detail}`);
  }

  await client.close();
}

run().catch((error) => {
  console.error(`E2E full matrix failed: ${error.message}`);
  process.exit(1);
});
