# K8sCortex Helm chart

Runs [K8sCortex](https://github.com/apatilgtn/k8scortex-mcp) as a shared MCP service for a team:
Streamable HTTP and SSE on `/mcp`, OIDC on every request, role tiers, per-cluster policies and an
audit log on stdout.

```bash
helm install k8scortex ./charts/k8scortex -n platform-mcp --create-namespace \
  --set auth.oidc.issuer=https://login.example.com \
  --set auth.oidc.audience=k8scortex \
  --set auth.oidc.rolesClaim=groups \
  --set-json 'auth.oidc.roleMap={"k8s-devs":"developer","k8s-sre":"sre","k8s-platform":"platform-engineer"}'
```

The chart refuses to render without an identity provider unless `auth.disabled=true`.

## Two layers of access

| Layer | Set by | Decides |
|---|---|---|
| K8sCortex roles | your IdP groups → `auth.oidc.roleMap`, plus `policies` in the cluster registry | which tools each person may call, per cluster |
| Kubernetes RBAC | `rbac.*` here, or your own bindings on remote clusters | the most anyone can do through the server's identity |

`rbac.allowWrites` is **false** by default: the server can read (built-in `view` role, no Secrets, plus
nodes, storage classes, metrics, Argo CD, Flux and VPA objects) and write tools return 403. Set it to
`true` to grant exactly the verbs the curated write tools use.

## More clusters and clouds

Give the pod a cloud identity with `serviceAccount.annotations` (GKE Workload Identity, EKS IRSA,
Azure Workload Identity with `podLabels`), then list clusters in `clusters.config`. The cluster the
chart runs in is called `inClusterContext`. See [`kubernetes/example-values.yaml`](../../kubernetes/example-values.yaml).

## Values

| Value | Default | |
|---|---|---|
| `image.repository` / `image.tag` | `ghcr.io/apatilgtn/k8scortex-mcp` / appVersion | |
| `auth.oidc.issuer`, `audience`, `rolesClaim`, `roleMap`, `jwksUri` | | Any OIDC provider |
| `auth.entra.tenantId`, `clientId` | | Shorthand for Entra ID |
| `auth.disabled` | `false` | Local experiments only |
| `clusters.config` / `existingConfigMap` / `defaultCluster` | | Cluster registry (`CLUSTERS_CONFIG`) |
| `rbac.create` / `allowWrites` / `readAllResources` | `true` / `false` / `false` | Kubernetes RBAC for this cluster |
| `replicaCount` | `1` | Above 1 the Service uses ClientIP affinity (sessions are per pod) |
| `serviceAccount.annotations`, `podLabels` | | Cloud identity |
| `networkPolicy.enabled`, `ingressFrom` | `false` | Restrict who reaches port 3000 |
| `podDisruptionBudget.enabled` | `false` | |
| `prometheusRule.enabled` | `false` | Availability and restart alerts |
| `audit.logFile` | `/var/log/k8scortex/audit.log` | Local copy; stdout is the primary audit stream |
| `sessionIdleTtlMs` | `1800000` | |
| `extraEnv`, `envFrom`, `resources`, `nodeSelector`, `tolerations`, `affinity` | | |

The pod runs as non-root with a read-only root filesystem and all capabilities dropped.
