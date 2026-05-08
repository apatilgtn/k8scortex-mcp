# KubeNexus Operator Runbook

> This runbook is for the **Platform Engineering** team responsible for deploying, operating, and maintaining the KubeNexus MCP server in production.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Deployment](#deployment)
3. [Configuration Reference](#configuration-reference)
4. [Credential Rotation](#credential-rotation)
5. [Scaling](#scaling)
6. [Monitoring & Alerting](#monitoring--alerting)
7. [Incident Response](#incident-response)
8. [Upgrade Procedure](#upgrade-procedure)
9. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Callers                             │
│  Claude Desktop │ Prism Agent │ CI/CD │ MCP Inspector   │
└────────┬──────────────┬──────────┬──────────────────────┘
         │ stdio        │ HTTP/SSE │ HTTP/SSE
         ▼              ▼          ▼
┌─────────────────────────────────────────────────────────┐
│                  KubeNexus MCP Server                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐             │
│  │ OIDC Auth│→ │ RBAC     │→ │ Tool      │             │
│  │ Middleware│  │ Enforcer │  │ Handlers  │             │
│  └──────────┘  └──────────┘  └─────┬─────┘             │
│                                    │                    │
│  ┌──────────────────────┐  ┌───────▼─────────┐         │
│  │ Audit Logger         │  │ Cluster Store   │         │
│  │ (stderr / stdout /   │  │ (Key Vault +    │         │
│  │  audit.log)          │  │  5-min TTL)     │         │
│  └──────────────────────┘  └───────┬─────────┘         │
│                                    │                    │
└────────────────────────────────────┼────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              ┌──────────┐   ┌──────────┐    ┌──────────┐
              │ AKS      │   │ EKS      │    │ GKE      │
              │ Clusters  │   │ Clusters  │    │ Clusters  │
              └──────────┘   └──────────┘    └──────────┘
```

**Namespace:** `platform-mcp`  
**Service type:** ClusterIP (private only)  
**DNS:** `mcp-k8s.platform.internal`

---

## Deployment

### Prerequisites

- AKS cluster with Workload Identity enabled
- Azure Key Vault with CSI Secrets Store Driver
- `platform-mcp` namespace created
- Container image built and pushed to ACR

### Deploy from scratch

```bash
# 1. Create the namespace
kubectl apply -f kubernetes/namespace.yaml

# 2. Deploy RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding)
kubectl apply -f kubernetes/rbac.yaml

# 3. Deploy Key Vault SecretProviderClass
kubectl apply -f kubernetes/secret-provider-class.yaml

# 4. Deploy NetworkPolicy
kubectl apply -f kubernetes/network-policy.yaml

# 5. Deploy the server
kubectl apply -f kubernetes/deployment.yaml

# 6. Deploy the service
kubectl apply -f kubernetes/service.yaml

# 7. Deploy HPA
kubectl apply -f kubernetes/hpa.yaml

# 8. Verify
kubectl -n platform-mcp get pods
kubectl -n platform-mcp logs -l app=kubenexus --tail=20
```

### Verify health

```bash
# Health check
kubectl -n platform-mcp exec deploy/kubenexus -- curl -s http://localhost:3000/health
# Expected: "OK"

# Check tool listing
kubectl -n platform-mcp port-forward svc/kubenexus 3000:3000
curl http://localhost:3000/mcp
# Expected: SSE stream with event: endpoint
```

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP listening port |
| `DISABLE_AUTH` | No | `false` | Bypass OIDC auth (dev only — **never in prod**) |
| `TENANT_ID` | Prod | — | Entra ID tenant ID for OIDC validation |
| `CLIENT_ID` | Prod | — | Entra ID application client ID |
| `AZURE_KEYVAULT_URI` | Prod | — | Key Vault URL (e.g. `https://kv-kubenexus.vault.azure.net`) |
| `KUBECONFIG_SECRET_PREFIX` | No | `kubeconfig-` | Key Vault secret name prefix for cluster kubeconfigs |
| `CLUSTER_REGISTRY_SECRET` | No | `kubenexus-cluster-index` | Key Vault secret holding the cluster index JSON |
| `AUDIT_LOG_FILE` | No | `./audit.log` | Local file path for audit log append |

### Key Vault Secrets

| Secret Name | Format | Description |
|---|---|---|
| `kubenexus-cluster-index` | JSON array | List of `{ name, cloud, region }` objects |
| `kubeconfig-<cluster-name>` | Base64 | Per-cluster kubeconfig (base64-encoded YAML) |

---

## Credential Rotation

### Rotating a cluster kubeconfig

1. Generate a new kubeconfig for the target cluster
2. Base64-encode it: `cat kubeconfig.yaml | base64 -w0`
3. Update the Key Vault secret:
   ```bash
   az keyvault secret set \
     --vault-name kv-kubenexus \
     --name kubeconfig-prod-aks-au \
     --value "$(cat kubeconfig.yaml | base64 -w0)"
   ```
4. **No restart needed** — the 5-minute TTL cache will pick up the new credential automatically
5. Verify by calling `get_cluster_info { cluster: "prod-aks-au" }` after 5 minutes

### Adding a new cluster

1. Add the cluster entry to the index secret:
   ```bash
   # Fetch current index
   az keyvault secret show --vault-name kv-kubenexus --name kubenexus-cluster-index --query value -o tsv > index.json
   
   # Add new entry
   jq '. += [{"name":"prod-eks-us","cloud":"aws","region":"us-east-1"}]' index.json > updated.json
   
   # Update
   az keyvault secret set --vault-name kv-kubenexus --name kubenexus-cluster-index --value "$(cat updated.json)"
   ```

2. Upload the cluster's kubeconfig:
   ```bash
   az keyvault secret set \
     --vault-name kv-kubenexus \
     --name kubeconfig-prod-eks-us \
     --value "$(cat eks-kubeconfig.yaml | base64 -w0)"
   ```

3. Verify: `list_clusters` will show the new cluster after cache TTL expires.

### Removing a cluster

1. Remove from the index secret (edit JSON, re-upload)
2. Delete the kubeconfig secret: `az keyvault secret delete --vault-name kv-kubenexus --name kubeconfig-old-cluster`
3. No restart needed

---

## Scaling

### Horizontal Pod Autoscaler

KubeNexus scales based on CPU utilisation:

```yaml
# kubernetes/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: kubenexus
  namespace: platform-mcp
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: kubenexus
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### Manual scaling

```bash
kubectl -n platform-mcp scale deployment kubenexus --replicas=5
```

### Load testing

```bash
# Run the load test script
node load-test.js --target http://kubenexus.platform-mcp:3000/mcp --concurrency 50 --duration 60
```

---

## Monitoring & Alerting

### Key Metrics to Watch

| Metric | Source | Threshold |
|---|---|---|
| Pod availability | `kube_deployment_status_available_replicas` | ≥ 2 |
| Tool call error rate | Audit log `status: "failure"` | < 5% |
| Auth failure rate | Audit log `status: "denied"` | < 0.1% (spike = attack) |
| p95 latency | Tool call round-trip time | < 2 seconds |
| Audit log delivery lag | Timestamp diff to Log Analytics | < 30 seconds |
| Key Vault 429s | Azure Monitor | 0 (throttling) |

### Alert Rules

See `kubernetes/alerts.yaml` for Prometheus alerting rules covering:
- `KubeNexusDown` — fewer than 2 ready replicas for 5 minutes
- `KubeNexusHighErrorRate` — tool error rate > 5% for 10 minutes
- `KubeNexusAuthFailureSpike` — auth denial rate > 1% for 5 minutes
- `KubeNexusHighLatency` — p95 latency > 3 seconds for 10 minutes

---

## Incident Response

### Symptom: "Connection refused" from callers

1. Check pods: `kubectl -n platform-mcp get pods`
2. Check logs: `kubectl -n platform-mcp logs -l app=kubenexus --tail=50`
3. Check service: `kubectl -n platform-mcp get svc kubenexus`
4. Check endpoints: `kubectl -n platform-mcp get endpoints kubenexus`
5. If no pods are ready → check HPA, resource quotas, node capacity

### Symptom: "Unauthorized" errors

1. Verify the caller's JWT token is not expired
2. Check the `TENANT_ID` and `CLIENT_ID` env vars match Entra ID
3. Check Entra ID JWKS endpoint is reachable from the pod
4. If behind Zscaler/proxy → verify `NODE_TLS_REJECT_UNAUTHORIZED` is not needed

### Symptom: "Key Vault fetch failed"

1. Check `AZURE_KEYVAULT_URI` env var
2. Verify Workload Identity is configured: `kubectl -n platform-mcp describe sa kubenexus`
3. Check federated credential: `az ad app federated-credential list --id <CLIENT_ID>`
4. Test from the pod: `kubectl -n platform-mcp exec deploy/kubenexus -- curl -s "$IDENTITY_ENDPOINT"`

### Symptom: Tools return errors for a specific cluster

1. Verify the cluster exists in the index: call `list_clusters`
2. Check the kubeconfig secret exists in Key Vault
3. Verify network connectivity to the target cluster's API server
4. Check if the kubeconfig has expired credentials → rotate

---

## Upgrade Procedure

### Rolling update (no downtime)

```bash
# 1. Build the new image
docker build -t acr.azurecr.io/kubenexus:v1.2.0 .
docker push acr.azurecr.io/kubenexus:v1.2.0

# 2. Update the deployment
kubectl -n platform-mcp set image deployment/kubenexus kubenexus=acr.azurecr.io/kubenexus:v1.2.0

# 3. Monitor rollout
kubectl -n platform-mcp rollout status deployment/kubenexus

# 4. Verify
kubectl -n platform-mcp exec deploy/kubenexus -- curl -s http://localhost:3000/health
```

### Rollback

```bash
kubectl -n platform-mcp rollout undo deployment/kubenexus
```

---

## Troubleshooting

| Issue | Check |
|---|---|
| Server won't start | `npm run build` — check for TypeScript compilation errors |
| SSE transport error "stream not readable" | Ensure `express.json()` is NOT applied to the `/messages` POST route |
| "Already connected to transport" | Server handles reconnection — this is logged but auto-recovered |
| Audit log corrupts stdio | Audit logger must use `stderr`, not `stdout`, in stdio mode |
| Minikube connection refused | Run `minikube status` — start with `minikube start --driver=docker` |
| Rancher Desktop sudo failure | Corporate privilege management blocks bridged networking — use minikube instead |
