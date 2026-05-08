# KubeNexus Developer Guide

> **KubeNexus** is your team's natural-language interface to Kubernetes.  
> Query pods, read logs, scale deployments, and triage incidents — from Claude, CI/CD, or any MCP client — without ever running `kubectl`.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Available Tools](#available-tools)
3. [Using KubeNexus from Claude Desktop](#claude-desktop)
4. [Using KubeNexus from the MCP Inspector](#mcp-inspector)
5. [Multi-cluster Queries](#multi-cluster)
6. [Common Workflows](#common-workflows)
7. [Role Permissions](#role-permissions)
8. [FAQ](#faq)

---

## Quick Start

### Option A — Claude Desktop (Recommended)

KubeNexus is pre-configured in Claude Desktop. Open a new conversation and ask:

> *"List all pods in the default namespace"*

Claude will call `list_pods` and return the result. That's it — no kubectl, no kubeconfig.

### Option B — Programmatic (SSE/HTTP)

```bash
# Start the server
DISABLE_AUTH=true PORT=3001 npm run dev

# Connect with the MCP Inspector
npx @modelcontextprotocol/inspector sse http://localhost:3001/mcp
```

### Option C — Claude Code / CLI

Add to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "k8scortex": {
      "command": "node",
      "args": ["/path/to/k8scortex-mcp/dist/stdio.js"],
      "env": { "DISABLE_AUTH": "true" }
    }
  }
}
```

---

## Available Tools

### Workload Visibility

| Tool | Description | Example Query |
|---|---|---|
| `list_pods` | List pods with status and IP | *"Show me all pods in the payments namespace"* |
| `get_pod_logs` | Fetch container logs | *"Get the last 50 lines of logs from the checkout pod"* |
| `describe_deployment` | Full deployment spec | *"Describe the api-gateway deployment"* |
| `list_statefulsets` | List StatefulSets and readiness | *"List StatefulSets in data-platform"* |
| `describe_statefulset` | Full StatefulSet spec/status | *"Describe the postgres StatefulSet"* |
| `list_daemonsets` | List DaemonSets and scheduling health | *"List DaemonSets in kube-system"* |
| `describe_daemonset` | Full DaemonSet spec/status | *"Describe the cni DaemonSet"* |
| `list_nodes` | List cluster nodes | *"What nodes are in the cluster?"* |

### Deployment Operations

| Tool | Description | Example Query |
|---|---|---|
| `scale_deployment` | Scale replicas (dry-run default) | *"Scale nginx to 5 replicas"* |
| `restart_pod` | Delete a pod to trigger restart | *"Restart the stuck checkout-abc pod"* |

> **Safety note:** Both tools default to `dryRun: true`. Claude will show you what *would* happen. Say *"actually do it"* or *"run it for real"* to execute with `dryRun: false`.

### Configuration & Policy

| Tool | Description | Example Query |
|---|---|---|
| `get_configmap` | Read ConfigMap data | *"What's in the app-config ConfigMap?"* |
| `describe_namespace_quota` | Resource quota usage | *"How much CPU is the team using in the billing namespace?"* |
| `list_events` | Recent namespace events | *"Show me recent events in kube-system"* |
| `list_persistent_volume_claims` | PVC state, binding, storage class, and capacity | *"List PVCs in payments and show pending claims"* |
| `get_effective_permissions` | ServiceAccount capability matrix via SAR checks | *"Can payments-api service account list pods and patch deployments?"* |

### Generic Read Coverage

| Tool | Description | Example Query |
|---|---|---|
| `list_k8s_resources` | Generic list for arbitrary resource kind/group | *"List daemonsets in kube-system via generic read"* |
| `get_k8s_resource` | Generic get for arbitrary resource kind/group | *"Get rolebinding read-secrets in development"* |

These tools are read-only helpers to avoid dead ends on resource types outside curated workflows.

### Observability Bridging

| Tool | Description | Example Query |
|---|---|---|
| `get_hpa_status` | HPA metrics and scaling | *"Is the checkout HPA scaling correctly?"* |
| `list_warning_events` | Warning events only | *"Are there any warnings in the payments namespace?"* |
| `get_node_pressure` | Node resource pressure | *"Does the worker-01 node have memory pressure?"* |

### Multi-cluster Discovery

| Tool | Description | Example Query |
|---|---|---|
| `list_clusters` | All registered clusters | *"What clusters does KubeNexus know about?"* |
| `get_cluster_info` | Cluster health summary | *"How many nodes are ready on prod-aks-au?"* |

---

## Claude Desktop

### Installation

Claude Desktop is pre-configured. When you open Claude, look for the 🔨 hammer icon in the message bar — clicking it shows **KubeNexus** and its available tools.

### Natural Language Examples

**Incident triage:**
> *"I'm seeing errors in the checkout service. Show me the pods in the payments namespace, any warning events, and the last 100 lines of logs from the checkout pod."*

Claude will call `list_pods`, `list_warning_events`, and `get_pod_logs` in sequence and summarise findings.

**Deployment verification:**
> *"We just deployed v2.3 of the billing service. Can you verify the deployment is healthy — check the pods are running and there are no warning events?"*

**Cross-cluster comparison:**
> *"Compare the node count and pressure status between our staging and prod clusters."*

---

## MCP Inspector

The MCP Inspector is a browser-based tool for directly testing KubeNexus.

```bash
# Start the server
DISABLE_AUTH=true PORT=3001 npm run dev

# Launch Inspector (opens browser)
npx @modelcontextprotocol/inspector sse http://localhost:3001/mcp
```

1. Set **Transport Type** → `SSE`
2. Set **URL** → `http://localhost:3001/mcp`
3. Click **Connect**
4. Navigate to the **Tools** tab
5. Select a tool, fill in parameters, click **Run Tool**

---

## Multi-cluster

Every tool accepts an optional `cluster` parameter. If omitted, it defaults to `"default"`.

```
"List pods in the payments namespace on the staging cluster"
→ list_pods { namespace: "payments", cluster: "staging-aks-au" }

"Scale the API deployment to 10 replicas on prod"
→ scale_deployment { namespace: "api", deploymentName: "api-gateway", replicas: 10, cluster: "prod-aks-au" }
```

To discover available clusters:
> *"What clusters are registered?"*

---

## Common Workflows

### 1. Pod crash triage

```
You:     "There are CrashLoopBackOff pods in the billing namespace. Help me investigate."
Claude:  → list_pods { namespace: "billing" }
         → list_warning_events { namespace: "billing" }
         → get_pod_logs { namespace: "billing", podName: "billing-worker-xyz", tailLines: 200 }
Claude:  "The billing-worker pod is crash-looping due to an OOM kill. The container
          is requesting 128Mi but consuming 450Mi. Recommend increasing the memory
          limit or investigating the memory leak in the latest release."
```

### 2. Pre-release deployment check

```
You:     "We're about to release v3.1. Check the staging deployment is healthy."
Claude:  → list_pods { namespace: "staging", cluster: "staging-aks-au" }
         → describe_deployment { namespace: "staging", deploymentName: "api-v3", cluster: "staging-aks-au" }
         → list_warning_events { namespace: "staging", cluster: "staging-aks-au" }
Claude:  "All 3 replicas are running, the deployment is at generation 4 with no rollback
          history, and there are zero warning events. Staging looks healthy for promotion."
```

### 3. Capacity planning

```
You:     "Are we running low on resources on the prod cluster?"
Claude:  → get_cluster_info { cluster: "prod-aks-au" }
         → get_node_pressure { nodeName: "aks-nodepool-001" }
         → describe_namespace_quota { namespace: "production" }
Claude:  "You have 5 nodes, all healthy. Node aks-nodepool-001 shows no memory/disk/PID
          pressure. The production namespace is using 60% of its CPU quota and 45% of memory."
```

---

## Role Permissions

Your access level is determined by your Entra ID role claims. Ask your platform team if you need elevated access.

| Role | What You Can Do |
|---|---|
| `developer` | Read pods, logs, deployments, nodes, clusters |
| `team-lead` | + Read ConfigMaps, quotas, events |
| `release-manager` | + Scale deployments, restart pods |
| `sre` | + HPA status, warning events, node pressure |
| `platform-engineer` | Everything |

If you try a tool you don't have access to, you'll see:
> *"Unauthorized to invoke tool: scale_deployment"*

---

## FAQ

**Q: Do I need kubectl installed?**  
No. KubeNexus handles all Kubernetes API calls server-side.

**Q: Can I accidentally break production?**  
Destructive tools (`scale_deployment`, `restart_pod`) default to dry-run mode. You must explicitly confirm to execute.

**Q: Which clusters can I access?**  
Ask: *"What clusters does KubeNexus know about?"* — it will list all registered clusters.

**Q: How do I report an issue?**  
Contact the Platform Engineering team or file an issue in the `k8snexus-mcp` repository.

**Q: Is my activity logged?**  
Yes. Every tool call is recorded with your identity, the tool name, arguments, and outcome. This is for security and compliance — not performance monitoring.
