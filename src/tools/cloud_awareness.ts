import { getK8sClientForCluster } from "../cluster-store.js";

const CLUSTER_PROP = { cluster: { type: "string", description: "Target cluster name (default: 'default')" } };

type NodePoolLabel = {
  key: string;
  cloud: "aks" | "eks" | "gke" | "unknown";
};

function detectNodePoolLabel(nodes: any[]): NodePoolLabel {
  const candidates: NodePoolLabel[] = [
    { key: "agentpool", cloud: "aks" },
    { key: "eks.amazonaws.com/nodegroup", cloud: "eks" },
    { key: "cloud.google.com/gke-nodepool", cloud: "gke" },
  ];

  for (const c of candidates) {
    if (nodes.some((n) => n.metadata?.labels?.[c.key])) {
      return c;
    }
  }

  return { key: "", cloud: "unknown" };
}

function safeJson(content: any): string {
  return JSON.stringify(content, null, 2);
}

function isMetricsUnavailable(err: any): boolean {
  const text = String(err?.body?.message || err?.body || err?.message || "").toLowerCase();
  return text.includes("metrics.k8s.io") || text.includes("service unavailable") || text.includes("not found") || text.includes("could not find the requested resource");
}

function detectWorkloadIdentityCloud(annotations: Record<string, string> = {}): "aks" | "eks" | "gke" | "unknown" {
  if (annotations["azure.workload.identity/client-id"] || annotations["azure.workload.identity/tenant-id"]) return "aks";
  if (annotations["eks.amazonaws.com/role-arn"]) return "eks";
  if (annotations["iam.gke.io/gcp-service-account"]) return "gke";
  return "unknown";
}

export const cloudAwarenessTools = [
  {
    name: "list_node_pools",
    description: "Groups nodes by managed-cloud node pool labels (AKS/EKS/GKE) and reports pool health.",
    inputSchema: {
      type: "object",
      properties: { ...CLUSTER_PROP },
      required: [],
    },
  },
  {
    name: "get_node_pool_detail",
    description: "Returns detailed node, spot/preemptible, and optional metrics view for a specific node pool.",
    inputSchema: {
      type: "object",
      properties: {
        poolName: { type: "string", description: "Node pool name" },
        ...CLUSTER_PROP,
      },
      required: ["poolName"],
    },
  },
  {
    name: "get_workload_identity_config",
    description: "Returns workload identity annotation configuration for a ServiceAccount (AKS/EKS/GKE conventions).",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "ServiceAccount namespace" },
        serviceAccountName: { type: "string", description: "ServiceAccount name" },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "serviceAccountName"],
    },
  },
  {
    name: "validate_workload_identity",
    description: "Validates identity chain from ServiceAccount annotation to pods using that ServiceAccount.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "ServiceAccount namespace" },
        serviceAccountName: { type: "string", description: "ServiceAccount name" },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "serviceAccountName"],
    },
  },
  {
    name: "list_pod_disruption_budgets",
    description: "Lists PodDisruptionBudgets in a namespace with budget satisfaction status.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace" },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
  {
    name: "get_pdb_status",
    description: "Returns detailed status and covered pods for a PodDisruptionBudget.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace" },
        pdbName: { type: "string", description: "PDB name" },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "pdbName"],
    },
  },
  {
    name: "list_vpas",
    description: "Lists VerticalPodAutoscaler objects in a namespace and their update mode/recommendation state.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace" },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
  {
    name: "get_vpa_recommendation",
    description: "Returns VPA recommendation lower/target/upper bounds for a workload when available.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace" },
        vpaName: { type: "string", description: "VPA object name" },
        ...CLUSTER_PROP,
      },
      required: ["namespace", "vpaName"],
    },
  },
  {
    name: "list_storage_classes",
    description: "Lists StorageClasses and indicates default class.",
    inputSchema: {
      type: "object",
      properties: { ...CLUSTER_PROP },
      required: [],
    },
  },
  {
    name: "get_storage_class",
    description: "Returns details for a specific StorageClass.",
    inputSchema: {
      type: "object",
      properties: {
        storageClassName: { type: "string", description: "StorageClass name" },
        ...CLUSTER_PROP,
      },
      required: ["storageClassName"],
    },
  },
  {
    name: "get_addon_health",
    description: "Checks health of common kube-system addons (CoreDNS, metrics-server, kube-proxy, CNI).",
    inputSchema: {
      type: "object",
      properties: { ...CLUSTER_PROP },
      required: [],
    },
  },
  {
    name: "list_limit_ranges",
    description: "Lists LimitRange objects in a namespace and default resource constraints.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace" },
        ...CLUSTER_PROP,
      },
      required: ["namespace"],
    },
  },
];

export async function handleCloudAwarenessTool(name: string, args: any): Promise<any> {
  const cluster = args.cluster || "default";
  const { coreV1Api, appsV1Api, customObjectsApi } = await getK8sClientForCluster(cluster);

  try {
    switch (name) {
      case "list_node_pools": {
        const nodesRes = await coreV1Api.listNode();
        const nodes = nodesRes.items || [];
        const labelInfo = detectNodePoolLabel(nodes);

        if (!labelInfo.key) {
          return { content: [{ type: "text", text: safeJson({ status: "degraded", message: "No known managed-cloud node pool labels detected", pools: [] }) }] };
        }

        const pools = new Map<string, any[]>();
        for (const node of nodes) {
          const poolName = node.metadata?.labels?.[labelInfo.key] || "unknown";
          if (!pools.has(poolName)) pools.set(poolName, []);
          pools.get(poolName)!.push(node);
        }

        const output = Array.from(pools.entries()).map(([poolName, poolNodes]) => {
          const ready = poolNodes.filter((n) => n.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True")).length;
          const unschedulable = poolNodes.filter((n) => n.spec?.unschedulable === true).length;
          const instanceTypes = Array.from(new Set(poolNodes.map((n) => n.metadata?.labels?.["node.kubernetes.io/instance-type"] || "unknown")));
          return {
            poolName,
            cloud: labelInfo.cloud,
            nodeCount: poolNodes.length,
            readyCount: ready,
            unschedulableCount: unschedulable,
            instanceTypes,
          };
        });

        return { content: [{ type: "text", text: safeJson({ status: "ok", detection: labelInfo, pools: output }) }] };
      }

      case "get_node_pool_detail": {
        const poolName = args.poolName;
        const nodesRes = await coreV1Api.listNode();
        const nodes = nodesRes.items || [];
        const labelInfo = detectNodePoolLabel(nodes);
        if (!labelInfo.key) {
          return { content: [{ type: "text", text: safeJson({ status: "degraded", message: "No known node pool label detected" }) }] };
        }

        const poolNodes = nodes.filter((n) => n.metadata?.labels?.[labelInfo.key] === poolName);
        if (!poolNodes.length) {
          return { content: [{ type: "text", text: safeJson({ status: "degraded", message: `Pool '${poolName}' not found`, detection: labelInfo }) }] };
        }

        let metricsByNode = new Map<string, any>();
        try {
          const metrics = await customObjectsApi.listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "nodes" }) as any;
          for (const m of metrics.items || []) metricsByNode.set(m.metadata?.name, m.usage || {});
        } catch (e) {
          if (!isMetricsUnavailable(e)) throw e;
        }

        const detail = poolNodes.map((n) => {
          const labels = n.metadata?.labels || {};
          const nodeName = n.metadata?.name || "";
          const spot = labels["cloud.google.com/gke-spot"] === "true" || labels["eks.amazonaws.com/capacityType"] === "SPOT" || String(labels["kubernetes.azure.com/scalesetpriority"] || "").toLowerCase() === "spot";
          return {
            name: nodeName,
            age: n.metadata?.creationTimestamp,
            kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
            osImage: n.status?.nodeInfo?.osImage,
            spot,
            unschedulable: n.spec?.unschedulable === true,
            metrics: metricsByNode.get(nodeName) || null,
          };
        });

        return { content: [{ type: "text", text: safeJson({ status: "ok", poolName, detection: labelInfo, nodes: detail }) }] };
      }

      case "get_workload_identity_config": {
        const namespace = args.namespace;
        const serviceAccountName = args.serviceAccountName;
        const sa = await coreV1Api.readNamespacedServiceAccount({ namespace, name: serviceAccountName });
        const annotations = sa.metadata?.annotations || {};
        const cloud = detectWorkloadIdentityCloud(annotations as Record<string, string>);

        const config: any = {
          namespace,
          serviceAccountName,
          cloud,
          status: cloud === "unknown" ? "degraded" : "ok",
          annotations,
        };

        if (cloud === "aks") {
          config.identity = {
            clientId: annotations["azure.workload.identity/client-id"] || null,
            tenantId: annotations["azure.workload.identity/tenant-id"] || null,
          };
        } else if (cloud === "eks") {
          config.identity = { roleArn: annotations["eks.amazonaws.com/role-arn"] || null };
        } else if (cloud === "gke") {
          config.identity = { gcpServiceAccount: annotations["iam.gke.io/gcp-service-account"] || null };
        } else {
          config.message = "No known workload identity annotation found on ServiceAccount.";
        }

        return { content: [{ type: "text", text: safeJson(config) }] };
      }

      case "validate_workload_identity": {
        const namespace = args.namespace;
        const serviceAccountName = args.serviceAccountName;
        const sa = await coreV1Api.readNamespacedServiceAccount({ namespace, name: serviceAccountName });
        const annotations = sa.metadata?.annotations || {};
        const cloud = detectWorkloadIdentityCloud(annotations as Record<string, string>);
        const pods = await coreV1Api.listNamespacedPod({ namespace, fieldSelector: `spec.serviceAccountName=${serviceAccountName}` });

        const findings: any[] = [];
        if (cloud === "unknown") {
          findings.push({ check: "serviceAccountAnnotation", status: "fail", message: "No known workload identity annotation found." });
        } else {
          findings.push({ check: "serviceAccountAnnotation", status: "pass", message: `Detected ${cloud} workload identity annotation.` });
        }

        if ((pods.items || []).length === 0) {
          findings.push({ check: "podBinding", status: "degraded", message: "No pods currently running with this ServiceAccount." });
        } else {
          findings.push({ check: "podBinding", status: "pass", message: `${pods.items.length} pod(s) running with ServiceAccount.` });
        }

        const podChecks = (pods.items || []).map((p: any) => ({
          pod: p.metadata?.name,
          namespace: p.metadata?.namespace,
          serviceAccountName: p.spec?.serviceAccountName,
          phase: p.status?.phase,
          status: p.spec?.serviceAccountName === serviceAccountName ? "pass" : "fail",
        }));

        const overall = findings.some((f) => f.status === "fail") ? "fail" : findings.some((f) => f.status === "degraded") ? "degraded" : "pass";

        return { content: [{ type: "text", text: safeJson({ status: overall, cloud, namespace, serviceAccountName, findings, podChecks }) }] };
      }

      case "list_pod_disruption_budgets": {
        const namespace = args.namespace;
        const pdbs = await customObjectsApi.listNamespacedCustomObject({ group: "policy", version: "v1", namespace, plural: "poddisruptionbudgets" }) as any;
        const items = (pdbs.items || []).map((p: any) => ({
          name: p.metadata?.name,
          minAvailable: p.spec?.minAvailable || null,
          maxUnavailable: p.spec?.maxUnavailable || null,
          currentHealthy: p.status?.currentHealthy || 0,
          desiredHealthy: p.status?.desiredHealthy || 0,
          disruptionsAllowed: p.status?.disruptionsAllowed || 0,
          satisfied: (p.status?.disruptionsAllowed || 0) > 0,
        }));
        return { content: [{ type: "text", text: safeJson(items) }] };
      }

      case "get_pdb_status": {
        const namespace = args.namespace;
        const pdbName = args.pdbName;
        const pdb = await customObjectsApi.getNamespacedCustomObject({ group: "policy", version: "v1", namespace, plural: "poddisruptionbudgets", name: pdbName }) as any;
        const selector = pdb.spec?.selector?.matchLabels || {};
        const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(",");
        const pods = labelSelector ? await coreV1Api.listNamespacedPod({ namespace, labelSelector }) : { items: [] as any[] };

        return {
          content: [{
            type: "text",
            text: safeJson({
              name: pdb.metadata?.name,
              namespace,
              minAvailable: pdb.spec?.minAvailable || null,
              maxUnavailable: pdb.spec?.maxUnavailable || null,
              currentHealthy: pdb.status?.currentHealthy || 0,
              desiredHealthy: pdb.status?.desiredHealthy || 0,
              disruptionsAllowed: pdb.status?.disruptionsAllowed || 0,
              wouldBlockDrain: (pdb.status?.disruptionsAllowed || 0) < 1,
              coveredPods: (pods.items || []).map((p: any) => ({ name: p.metadata?.name, phase: p.status?.phase })),
            }),
          }],
        };
      }

      case "list_vpas": {
        const namespace = args.namespace;
        try {
          const vpas = await customObjectsApi.listNamespacedCustomObject({ group: "autoscaling.k8s.io", version: "v1", namespace, plural: "verticalpodautoscalers" }) as any;
          const items = (vpas.items || []).map((v: any) => ({
            name: v.metadata?.name,
            updateMode: v.spec?.updatePolicy?.updateMode || "Auto",
            hasRecommendation: !!v.status?.recommendation,
          }));
          return { content: [{ type: "text", text: safeJson(items) }] };
        } catch (e) {
          return { content: [{ type: "text", text: safeJson({ status: "degraded", message: "VPA CRD/API not available in this cluster." }) }] };
        }
      }

      case "get_vpa_recommendation": {
        const namespace = args.namespace;
        const vpaName = args.vpaName;
        try {
          const vpa = await customObjectsApi.getNamespacedCustomObject({ group: "autoscaling.k8s.io", version: "v1", namespace, plural: "verticalpodautoscalers", name: vpaName }) as any;
          const recs = vpa.status?.recommendation?.containerRecommendations || [];
          return { content: [{ type: "text", text: safeJson({ status: "ok", name: vpaName, namespace, recommendations: recs }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: safeJson({ status: "degraded", message: "VPA recommendation unavailable (CRD missing or object not found)." }) }] };
        }
      }

      case "list_storage_classes": {
        const scs = await customObjectsApi.listClusterCustomObject({ group: "storage.k8s.io", version: "v1", plural: "storageclasses" }) as any;
        const items = (scs.items || []).map((s: any) => ({
          name: s.metadata?.name,
          provisioner: s.provisioner,
          reclaimPolicy: s.reclaimPolicy || null,
          volumeBindingMode: s.volumeBindingMode || null,
          isDefault: (s.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true") || (s.metadata?.annotations?.["storageclass.beta.kubernetes.io/is-default-class"] === "true"),
        }));
        return { content: [{ type: "text", text: safeJson(items) }] };
      }

      case "get_storage_class": {
        const storageClassName = args.storageClassName;
        const sc = await customObjectsApi.getClusterCustomObject({ group: "storage.k8s.io", version: "v1", plural: "storageclasses", name: storageClassName }) as any;
        return {
          content: [{
            type: "text",
            text: safeJson({
              name: sc.metadata?.name,
              provisioner: sc.provisioner,
              reclaimPolicy: sc.reclaimPolicy || null,
              volumeBindingMode: sc.volumeBindingMode || null,
              allowVolumeExpansion: !!sc.allowVolumeExpansion,
              parameters: sc.parameters || {},
              annotations: sc.metadata?.annotations || {},
            }),
          }],
        };
      }

      case "get_addon_health": {
        const kubeSystem = "kube-system";
        const deployments = await appsV1Api.listNamespacedDeployment({ namespace: kubeSystem });
        const daemonsets = await appsV1Api.listNamespacedDaemonSet({ namespace: kubeSystem });

        const findDep = (names: string[]) => deployments.items.find((d: any) => names.includes(d.metadata?.name || ""));
        const findDs = (names: string[]) => daemonsets.items.find((d: any) => names.includes(d.metadata?.name || ""));

        const coreDns = findDep(["coredns", "kube-dns"]);
        const metricsServer = findDep(["metrics-server"]);
        const kubeProxy = findDs(["kube-proxy"]);
        const cni = findDs(["aws-node", "azure-cni", "azure-cns", "gke-node-config", "calico-node", "cilium"]);

        const summary = {
          coredns: coreDns ? { status: (coreDns.status?.readyReplicas || 0) >= 1 ? "healthy" : "degraded", readyReplicas: coreDns.status?.readyReplicas || 0, replicas: coreDns.spec?.replicas || 0 } : { status: "missing" },
          metricsServer: metricsServer ? { status: (metricsServer.status?.readyReplicas || 0) >= 1 ? "healthy" : "degraded", readyReplicas: metricsServer.status?.readyReplicas || 0, replicas: metricsServer.spec?.replicas || 0 } : { status: "missing" },
          kubeProxy: kubeProxy ? { status: (kubeProxy.status?.numberReady || 0) >= 1 ? "healthy" : "degraded", numberReady: kubeProxy.status?.numberReady || 0, desired: kubeProxy.status?.desiredNumberScheduled || 0 } : { status: "missing" },
          cni: cni ? { name: cni.metadata?.name, status: (cni.status?.numberReady || 0) >= 1 ? "healthy" : "degraded", numberReady: cni.status?.numberReady || 0, desired: cni.status?.desiredNumberScheduled || 0 } : { status: "missing" },
        };

        return { content: [{ type: "text", text: safeJson(summary) }] };
      }

      case "list_limit_ranges": {
        const namespace = args.namespace;
        const limits = await coreV1Api.listNamespacedLimitRange({ namespace });
        const items = (limits.items || []).map((l: any) => ({
          name: l.metadata?.name,
          limits: (l.spec?.limits || []).map((x: any) => ({
            type: x.type,
            default: x.default || null,
            defaultRequest: x.defaultRequest || null,
            min: x.min || null,
            max: x.max || null,
          })),
        }));
        return { content: [{ type: "text", text: safeJson(items) }] };
      }

      default:
        throw new Error(`Unknown cloud awareness tool: ${name}`);
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: error.body ? JSON.stringify(error.body) : error.message }],
    };
  }
}
