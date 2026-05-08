# K8sCortex — Kubernetes MCP Server

[![smithery badge](https://smithery.ai/badge/apatil0431/k8scortex-mcp)](https://smithery.ai/server/apatil0431/k8scortex-mcp)
[![npm version](https://badge.fury.io/js/k8scortex-mcp.svg)](https://www.npmjs.com/package/k8scortex-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A production-grade Model Context Protocol (MCP) server that gives developers, AI agents, and automation pipelines a single, secure, natural-language interface to Kubernetes — across any cloud, any cluster, any team.

---

## Features

- **Curated multi-domain toolset** across workload, deployment, configuration, observability, jobs, networking, GitOps, cluster admin, and generic read paths
- **Multi-cluster routing** — target any registered cluster with a single `cluster` parameter
- **Entra ID OIDC** authentication with per-tool RBAC (5-tier role hierarchy)
- **Structured audit logging** — every tool call recorded with caller identity, arguments, and outcome
- **Dual transport** — SSE/HTTP for programmatic clients + stdio for Claude Desktop
- **Azure Key Vault** integration for dynamic credential management with 5-minute TTL cache
- **Dry-run safety** — destructive tools default to simulation mode
- **Generic read coverage** — list/get support for resources outside curated write paths to avoid troubleshooting dead-ends

## Install via npx (Fastest)

```bash
npx k8scortex-mcp
```

Or install globally:

```bash
npm install -g k8scortex-mcp
```

## Quick Start

### Prerequisites

- Node.js ≥ 18
- A Kubernetes cluster (minikube, Rancher Desktop, or AKS)
- `kubectl` configured with a valid context

### Install & Run

```bash
# Clone
git clone https://github.com/apatilgtn/k8scortex-mcp.git
cd k8scortex-mcp

# Install
npm install

# Build
npm run build

# Run (local dev mode — auth bypassed)
DISABLE_AUTH=true PORT=3001 npm run dev
```

### Connect with MCP Inspector

```bash
npx @modelcontextprotocol/inspector sse http://localhost:3001/mcp
```

### Connect with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "k8scortex": {
      "command": "node",
      "args": ["<path-to>/k8scortex-mcp/dist/stdio.js"],
      "env": {
        "DISABLE_AUTH": "true",
        "KUBECONFIG": "~/.kube/config"
      }
    }
  }
}
```

Restart Claude Desktop. Ask: *"List all pods in the default namespace"*.

---

## Tools

K8sCortex intentionally keeps writes curated and governed, while allowing flexible read access for diagnostics.

| Domain | Tool | Description |
|---|---|---|
| Workload | `list_pods` | List pods with status and IP |
| Workload | `get_pod_logs` | Fetch container logs |
| Workload | `describe_deployment` | Full deployment spec |
| Workload | `list_statefulsets` | List StatefulSets with rollout status |
| Workload | `describe_statefulset` | Detailed StatefulSet spec/status |
| Workload | `list_daemonsets` | List DaemonSets with scheduling status |
| Workload | `describe_daemonset` | Detailed DaemonSet spec/status |
| Workload | `list_nodes` | Cluster nodes with Ready status |
| Deploy | `scale_deployment` | Scale replicas (dry-run default) |
| Deploy | `restart_pod` | Delete pod to trigger restart |
| Config | `get_configmap` | Read ConfigMap data |
| Config | `describe_namespace_quota` | Resource quota usage |
| Config | `list_events` | Recent namespace events |
| Config | `list_persistent_volume_claims` | PVC status, bound volume, storage class, capacity |
| Config | `get_effective_permissions` | ServiceAccount SubjectAccessReview matrix |
| Generic Read | `list_k8s_resources` | Generic list for arbitrary resource kinds |
| Generic Read | `get_k8s_resource` | Generic get for arbitrary resource kinds |
| Observe | `get_hpa_status` | HPA metrics and scaling |
| Observe | `list_warning_events` | Warning events for triage |
| Observe | `get_node_pressure` | Node memory/disk/PID pressure |
| Multi | `list_clusters` | All registered clusters |
| Multi | `get_cluster_info` | Node count, versions, architecture |

For the evolving full catalog, see [docs/developer-guide.md](docs/developer-guide.md).

---

## Managed Risk

The largest functional risk in Kubernetes MCP is dead-end visibility on non-curated resources (for example StatefulSets, DaemonSets, PVCs, or CRDs). KubeNexus addresses this by combining:

- **Governed writes**: high-impact operations remain explicit, role-gated, and often dry-run by default.
- **Flexible reads**: generic read tools cover arbitrary resource kinds for diagnostics.

This keeps the governance posture strong while preserving practical troubleshooting coverage.

---

## Scope Boundaries (v1)

K8sCortex is designed as a governed platform interface, not an unrestricted Kubernetes super-client.

- **Generic write for any resource**: intentionally out of scope in v1. Writes are curated and role-gated by design.
- **Pod exec interactive sessions**: intentionally out of scope in v1. This requires stronger session controls and command-level auditing that are planned for a later version.

---

## Architecture

```
Claude / Prism Agent / CI-CD
        │
        ▼
┌──────────────────────────────┐
│     K8sCortex MCP Server     │
│  OIDC → RBAC → Tool → Audit │
│         │                    │
│   Cluster Store (Key Vault)  │
└──────────┬───────────────────┘
           │
    ┌──────┼──────┐
    ▼      ▼      ▼
   AKS    EKS    GKE
```

---

## Security

- **Authentication**: Entra ID OIDC tokens validated on every request
- **Authorization**: Role-based tool access (`developer` → `platform-engineer`)
- **Audit**: JSON-structured log per invocation with user, tool, args, status
- **Network**: ClusterIP only — no public endpoint
- **Credentials**: Key Vault with 5-minute TTL cache, no kubeconfigs on disk

---

## Project Structure

```
src/
├── index.ts              # Express SSE server
├── stdio.ts              # Stdio entry point (Claude Desktop)
├── auth.ts               # OIDC middleware
├── roles.ts              # RBAC role hierarchy
├── audit.ts              # Audit logger
├── context.ts            # AsyncLocalStorage user context
├── cluster-store.ts      # Dynamic K8s client factory
├── kubernetes.ts         # Client re-export
└── tools/
    ├── workload.ts       # list_pods, get_pod_logs, describe_deployment, list_nodes
    ├── deployment.ts     # scale_deployment, restart_pod
    ├── configuration.ts  # get_configmap, describe_namespace_quota, list_events
    ├── observability.ts  # get_hpa_status, list_warning_events, get_node_pressure
    └── multicluster.ts   # list_clusters, get_cluster_info

kubernetes/               # Production manifests
├── namespace.yaml
├── deployment.yaml
├── service.yaml
├── rbac.yaml
├── network-policy.yaml
├── hpa.yaml
├── secret-provider-class.yaml
└── alerts.yaml           # Prometheus alerting rules

docs/
├── developer-guide.md    # End-user documentation
├── operator-runbook.md   # Platform team operations
├── slos.md               # Service level objectives
└── adrs/                 # Architecture decision records
    ├── ADR-001-tool-taxonomy.md
    ├── ADR-002-idp-integration.md
    ├── ADR-003-role-model.md
    └── ADR-004-credential-management.md
```

---

## Documentation

- **[Developer Guide](docs/developer-guide.md)** — How to connect, available tools, example queries
- **[Operator Runbook](docs/operator-runbook.md)** — Deploy, upgrade, rotate credentials, incident response
- **[SLOs](docs/slos.md)** — Availability, latency, and alerting targets

## Document Files

- Word documents are consolidated in **[docs/docx](docs/docx)**.
- Current files:
  - `K8sCortex_Cloud_Testing_Publishing_Plan.docx`
  - `K8sCortex_Project_Plan.docx`
  - `K8sCortex_Project_Plan_v3.docx`
  - `K8sCortex_Project_Plan_v4.docx`

---

## License

Internal — Platform Engineering
