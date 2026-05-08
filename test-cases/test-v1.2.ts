import { handleNetworkTool } from "./src/tools/network.js";
import { handleResourceIntelligenceTool } from "./src/tools/resource_intelligence.js";
import { handleClusterAdminTool } from "./src/tools/cluster_admin.js";
import { handleWorkloadCreationTool } from "./src/tools/workload_creation.js";

async function run() {
  process.env.DISABLE_AUTH = "true";
  console.log("========================================");
  console.log("🚀 Testing KubeNexus v1.2 Tools");
  console.log("========================================\n");

  const namespace = "mcp-test-v12-" + Math.floor(Math.random() * 1000);

  try {
    // Setup
    console.log(`[0] Setup namespace: ${namespace}`);
    await handleWorkloadCreationTool("create_namespace", { namespaceName: namespace, dryRun: false });
    await handleWorkloadCreationTool("create_deployment", {
      namespace,
      deploymentName: "nginx-test",
      image: "nginx:alpine",
      replicas: 1,
      port: 80,
      dryRun: false
    });

    // --- NETWORK MANAGEMENT ---
    console.log(`\n[1] create_service: nginx-svc`);
    let res = await handleNetworkTool("create_service", {
      namespace,
      serviceName: "nginx-svc",
      type: "ClusterIP",
      port: 80,
      targetPort: 80,
      selector: { app: "nginx-test" },
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[2] create_network_policy: default-deny`);
    res = await handleNetworkTool("create_network_policy", {
      namespace,
      policyName: "default-deny",
      podSelector: {},
      policyTypes: ["Ingress"],
      dryRun: false
    });
    console.log(res.content[0].text);

    // Skip Ingress test since we need a valid Ingress Class for the cluster, but we can dry-run it
    console.log(`\n[3] update_ingress (DRY RUN):`);
    res = await handleNetworkTool("update_ingress", {
      namespace,
      ingressName: "test-ingress",
      annotations: { "nginx.ingress.kubernetes.io/rewrite-target": "/" },
      dryRun: true
    });
    console.log(res.content[0].text);

    // --- RESOURCE INTELLIGENCE ---
    console.log(`\n[4] set_resource_limits: nginx-test`);
    res = await handleResourceIntelligenceTool("set_resource_limits", {
      namespace,
      deploymentName: "nginx-test",
      containerName: "nginx-test", // The default container name for basic create_deployment
      cpuRequest: "100m",
      cpuLimit: "200m",
      memoryRequest: "128Mi",
      memoryLimit: "256Mi",
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[5] get_resource_recommendations: nginx-test`);
    res = await handleResourceIntelligenceTool("get_resource_recommendations", {
      namespace,
      deploymentName: "nginx-test"
    });
    console.log(res.content[0].text);

    console.log(`\n[6] get_cluster_resource_utilisation:`);
    res = await handleResourceIntelligenceTool("get_cluster_resource_utilisation", {});
    console.log(res.content[0].text);

    // --- CLUSTER ADMIN ---
    console.log(`\n[7] cordon_node: minikube`);
    res = await handleClusterAdminTool("cordon_node", { nodeName: "minikube", dryRun: false });
    console.log(res.content[0].text);

    await new Promise(r => setTimeout(r, 2000));

    console.log(`\n[8] taint_node: minikube`);
    res = await handleClusterAdminTool("taint_node", {
      nodeName: "minikube",
      key: "dedicated",
      value: "test",
      effect: "NoSchedule",
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[9] remove_taint: minikube`);
    res = await handleClusterAdminTool("remove_taint", {
      nodeName: "minikube",
      key: "dedicated",
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[10] drain_node (DRY RUN): minikube`);
    res = await handleClusterAdminTool("drain_node", { nodeName: "minikube", force: true, dryRun: true });
    console.log(res.content[0].text);

    console.log(`\n[11] uncordon_node: minikube`);
    res = await handleClusterAdminTool("uncordon_node", { nodeName: "minikube", dryRun: false });
    console.log(res.content[0].text);

    // --- CLEANUP ---
    console.log(`\n[12] Cleanup namespace: ${namespace}`);
    await handleWorkloadCreationTool("delete_namespace", { namespaceName: namespace, dryRun: false });

  } catch (e: any) {
    console.error("Test failed:", e);
  }
}

run();
