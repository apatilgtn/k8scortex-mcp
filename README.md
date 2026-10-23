# K8sCortex — Kubernetes MCP Server

[![smithery badge](https://smithery.ai/badge/apatil0431/k8scortex-mcp)](https://smithery.ai/server/apatil0431/k8scortex-mcp)
[![npm version](https://badge.fury.io/js/k8scortex-mcp.svg)](https://www.npmjs.com/package/k8scortex-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> A production-grade Model Context Protocol (MCP) server that gives developers, AI agents, and automation pipelines a single, secure, natural-language interface to Kubernetes — across any cloud, any cluster, any team.

---

## Features

- **Curated multi-domain toolset** across workload, deployment, configuration, observability, jobs, networking, GitOps, cluster admin, and generic read paths
- **Multi-cloud cluster providers** — kubeconfig contexts, Amazon EKS (IAM/IRSA), Google GKE (Workload Identity) and Azure Key Vault, mixed in one registry
- **Multi-cluster routing** — target any registered cluster with a single `cluster` parameter; writes require an explicit cluster when several are registered
- **Any OIDC identity provider** (Entra ID, Okta, Cognito, Keycloak, Google) with per-tool RBAC (5-tier role hierarchy) and per-cluster policies
- **Structured audit logging** — every tool call recorded with caller identity, arguments, and outcome
- **Dual transport** — SSE/HTTP for programmatic clients + stdio for Claude Desktop
- **Short-lived credentials** — EKS and GKE tokens are minted on demand and cached only until they expire
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

- Node.js ≥ 22 (the GKE provider's `google-auth-library` and the `jose` dependency of `jwks-rsa` need it)
- A Kubernetes cluster (minikube, kind, GKE, EKS, AKS or OpenShift)
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
        "KUBECONFIG": "~/.kube/config"
      }
    }
  }
}
```

Restart Claude Desktop. Ask: *"List all pods in the default namespace"*.

Every context in your kubeconfig is available as a cluster, so you can ask *"Compare the web app's ArgoCD revision between kind-dev and prod-eks"*. Set `K8SCORTEX_STDIO_ROLES=developer` to give the local session read-only tools.

---

## Multi-cloud setup

K8sCortex picks its cluster source from the environment:

| Source | When | Clusters |
|---|---|---|
| `CLUSTERS_CONFIG=/path/clusters.json` | Set | Clusters listed in the file, across any providers |
| Azure Key Vault | `AZURE_KEYVAULT_URI` set | The Key Vault cluster index |
| kubeconfig | Otherwise (or `USE_LOCAL_KUBECONFIG=true`) | Every context in `KUBECONFIG` / `~/.kube/config`, or the in-cluster service account |

`DEFAULT_CLUSTER` chooses the cluster used when a tool call names none. Read-only tools fall back to it; mutating tools require an explicit `cluster` whenever more than one cluster is registered.

### Cluster registry file

```json
{
  "defaultCluster": "dev",
  "clusters": [
    { "name": "dev", "provider": "kubeconfig", "context": "kind-dev", "labels": { "env": "dev" } },
    { "name": "prod-eks", "provider": "eks", "region": "us-east-1", "eksClusterName": "prod",
      "roleArn": "arn:aws:iam::111122223333:role/k8scortex", "labels": { "env": "prod" } },
    { "name": "prod-gke", "provider": "gke", "project": "my-project", "location": "us-central1",
      "gkeClusterName": "prod", "labels": { "env": "prod" } },
    { "name": "prod-aks", "provider": "azure-keyvault", "cloud": "aks", "region": "australiaeast",
      "keyVaultUri": "https://my-vault.vault.azure.net", "labels": { "env": "prod" } }
  ],
  "policies": [
    { "labels": { "env": "prod" }, "minRole": "sre", "appliesTo": "mutating" },
    { "match": "prod-*", "denyTools": ["drain_node", "delete_namespace"] }
  ]
}
```

| Provider | Credentials | Fields |
|---|---|---|
| `kubeconfig` | Whatever the context uses, including exec plugins (`aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin`) | `context`, `kubeconfigPath` |
| `eks` | Default AWS chain (IRSA, EKS Pod Identity, instance profile, env, SSO), optionally assuming `roleArn`; tokens are presigned STS URLs refreshed every 14 minutes | `region`, `eksClusterName`, `roleArn` |
| `gke` | Application Default Credentials (GKE Workload Identity, service account, `gcloud auth application-default login`) | `project`, `location`, `gkeClusterName`, `usePrivateEndpoint` |
| `azure-keyvault` | Managed identity; base64 kubeconfig in secret `kubeconfig-<name>` (or `secretName`) | `keyVaultUri`, `secretName` |

The EKS and GKE providers use optional dependencies (`@aws-sdk/client-eks`, `@aws-sdk/credential-providers`, `@smithy/signature-v4`, `@aws-crypto/sha256-js`, `google-auth-library`) that npm installs by default. The identity needs `eks:DescribeCluster` plus an EKS access entry, or `container.clusters.get` plus Kubernetes RBAC on GKE.

### Per-cluster policies

Policies match clusters by name glob (`match`) and/or `labels`, and can only **tighten** the global role table:

- `minRole` raises the role required on matching clusters (`appliesTo: "mutating"` limits it to write tools)
- `denyTools` disables tools for everyone on matching clusters

`compare_clusters` is checked against both clusters it reads.

### Authentication

HTTP mode refuses to start unless an identity provider is configured (or `DISABLE_AUTH=true`):

| Variable | Description |
|---|---|
| `OIDC_ISSUER` | Issuer URL(s), comma-separated; JWKS is discovered from `/.well-known/openid-configuration` |
| `OIDC_AUDIENCE` | Expected audience(s), comma-separated |
| `OIDC_JWKS_URI` | Optional JWKS URL override |
| `OIDC_ROLES_CLAIM` | Claim holding roles/groups (default `roles`; e.g. `groups`, `cognito:groups`, `realm_access.roles`) |
| `OIDC_ROLE_MAP` | JSON map from IdP group names to K8sCortex roles, e.g. `{"k8s-admins":"platform-engineer"}` |
| `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` | Shorthand for Entra ID (sets issuer, audience and JWKS) |

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

The largest functional risk in Kubernetes MCP is dead-end visibility on non-curated resources (for example StatefulSets, DaemonSets, PVCs, or CRDs). K8sCortex addresses this by combining:

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
│  OIDC → RBAC → Policy → Tool │
│            → Audit           │
│         │                    │
│     Cluster Registry         │
│ kubeconfig│EKS│GKE│KeyVault  │
└──────────┬───────────────────┘
           │
    ┌──────┼──────┬──────┐
    ▼      ▼      ▼      ▼
   AKS    EKS    GKE  OpenShift / local
```

---

## Security

- **Authentication**: OIDC tokens (issuer, audience and signature) validated on every request; sessions are bound to the user that created them
- **Authorization**: Role-based tool access (`developer` → `platform-engineer`), tightened per cluster by policies
- **Audit**: JSON-structured log per invocation with user, tool, cluster, provider and outcome; secret values are redacted
- **Network**: ClusterIP only — no public endpoint
- **Credentials**: Short-lived EKS/GKE tokens or Key Vault kubeconfigs, cached only until expiry

---

## Project Structure

```
src/
├── index.ts              # HTTP server (StreamableHTTP + SSE)
├── stdio.ts              # Stdio entry point (Claude Desktop)
├── server.ts             # Tool registry, authorization and dispatch
├── auth.ts               # OIDC middleware
├── roles.ts              # RBAC role hierarchy and per-cluster policies
├── audit.ts              # Audit logger with redaction
├── context.ts            # AsyncLocalStorage user context
├── cluster-store.ts      # Per-cluster K8s client cache
├── clusters/
│   ├── registry.ts       # Cluster registry and CLUSTERS_CONFIG loader
│   ├── kubeconfig.ts     # kubeconfig contexts provider
│   ├── eks.ts            # Amazon EKS provider
│   ├── gke.ts            # Google GKE provider
│   └── azure-keyvault.ts # Azure Key Vault provider
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
