# Changelog

## v1.1.1 - October 23, 2026

### Fixes found on a real GKE cluster

- `get_addon_health` reported metrics-server missing, kube-proxy degraded and the CNI missing on GKE Standard; it now matches versioned addon names (`metrics-server-v1.36.0`), kube-proxy static pods (or a Cilium dataplane) and GKE's `netd` / `anetd`
- `list_events` and `list_warning_events` kept the first 50 events in name order and dropped the newest; they now return the 50 most recent, newest first
- `rollout_undo` failed with 409 Conflict when the Deployment changed mid-call (for example an HPA scaling it); it now patches only `spec.template`, like `kubectl rollout undo`, and drops the old ReplicaSet's `pod-template-hash` label

### Packaging

- Requires Node.js 22 or later; on older Node npm silently skipped the GKE provider's `google-auth-library` dependency

### Testing

- New `npm run test:e2e:gke`: the native `gke` and `kubeconfig` providers, all 75 tools and per-cluster policies against a real GKE cluster (100/100 on GKE 1.36)
- Unit tests replaying API responses captured from GKE; the auth/audit suite no longer depends on the local kubeconfig

---

## v1.1.0 - October 22, 2026

### Multi-cloud

- Pluggable cluster providers: kubeconfig contexts, Amazon EKS (STS-presigned tokens via IRSA / Pod Identity, optional role assumption), Google GKE (Application Default Credentials / Workload Identity) and Azure Key Vault
- `CLUSTERS_CONFIG` registry file mixes providers with labels, a default cluster and per-cluster policies
- Every kubeconfig context is now a cluster in local mode; previously the `cluster` argument was ignored when `DISABLE_AUTH=true`
- Per-cluster policies (`minRole`, `denyTools`, matched by name glob or labels) that can only tighten access; `compare_clusters` checks both clusters
- Mutating tools require an explicit `cluster` when more than one cluster is registered
- `list_clusters` filters by cloud, region and labels; `get_cluster_info` reports Kubernetes version and detected platform (EKS, GKE, AKS, OpenShift)

### Security

- Legacy SSE transport fixed: one transport per session (a second client used to take over the first one's session) and message bodies are parsed correctly again
- HTTP sessions are bound to the authenticated user and idle StreamableHTTP sessions expire
- Tool calls without an authenticated user are denied instead of running as `platform-engineer`
- Generic OIDC (`OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_ROLES_CLAIM`, `OIDC_ROLE_MAP`) with issuer and algorithm checks; the server refuses to start with auth enabled but unconfigured
- Secret values are redacted from audit logs; audit records include the resolved cluster and provider
- Generic read tools no longer expose secret-bearing resources and respect the `get_configmap` role for configmaps
- `@modelcontextprotocol/sdk` upgraded to 1.32.1

### Fixes found by the KWOK end-to-end matrix

- `scale_deployment`, `cordon_node`, `uncordon_node`, `taint_node`, `remove_taint` and `drain_node` failed with HTTP 400 whenever `dryRun` was false: their merge-patch bodies were sent as JSON Patch
- `taint_node` replaced all of a node's taints with the new one; it now keeps the others
- `list_limit_ranges` always reported `default: null`
- `list_flux_helm_releases` / `get_flux_helm_release` reported `lastAppliedRevision: "Unknown"` for Flux HelmRelease v2; they now read `status.history`

### Testing

- New `npm run test:e2e:kwok`: two KWOK clusters (GKE-like and EKS-like) with Flux, Argo CD, VPA, metrics and log fixtures; 164 scenarios covering all 75 tools, multi-cluster routing, registry policies, OIDC over StreamableHTTP and SSE, session isolation, audit redaction and startup checks

### Breaking changes

- HTTP mode exits at startup unless `OIDC_ISSUER`/`OIDC_AUDIENCE` or `ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID` is set (or `DISABLE_AUTH=true`)
- `DISABLE_AUTH` only controls authentication; the cluster source is chosen by `CLUSTERS_CONFIG`, `AZURE_KEYVAULT_URI` or kubeconfig
- With the Key Vault index, clusters must be listed in the index; set `DEFAULT_CLUSTER` when relying on the implicit default
- Stdio mode no longer needs `DISABLE_AUTH`; use `K8SCORTEX_STDIO_ROLES` to restrict the local session

---

## v1.0.1 - May 8, 2026

### New tools

- 7 new FluxCD tools: `list_flux_kustomizations`, `list_flux_helm_releases`, `get_flux_helm_release`, `list_flux_sources`, `suspend_flux_resource`, `resume_flux_resource`, `list_flux_alerts`
- Full Flux v2 support across Kustomization, HelmRelease, GitRepository, HelmRepository, OCIRepository, Bucket, and Notification Alert CRDs
- Total tool count: 75 (up from 68)
- RBAC roles updated: Flux read tools at `developer` tier, suspend/resume at `release-manager` tier

### Testing (v1.0.1)

- 70-tool E2E matrix on Minikube with Flux v2 fixtures: PASS=70 FAIL=0
- metrics-server enabled on Minikube — resource intelligence tools now pass in all environments

### npm

- First public npm release
- `npx k8scortex-mcp` entry point via stdio transport
- MIT licence

---

## v1.0.0 - May 6, 2026

### What's new

- 68 Kubernetes management tools over MCP protocol
- ArgoCD GitOps integration (4 tools)
- Cloud-awareness layer for GKE (12 tools: node pools, workload identity, PDB, VPA, storage, addons)
- Role-based authorization (developer, team-lead, release-manager, sre, platform-engineer, ci-pipeline)
- Structured audit logging for compliance

### Security

- Org-grade OIDC/JWKS authentication (production) or test JWT (local)
- C-07: HTTP + MCP role enforcement with automated integration tests
- C-08: Compliance audit trail (JSON structured logs)
- C-11: SBOM generation for supply chain transparency
- C-12: Release notes completed

### Deployment

- Kubernetes manifests (RBAC, deployment, HPA, network policy)
- GKE validated on v1.35.3 with Minikube parity
- Dual transports: HTTP SSE (Claude Desktop) + stdio (VS Code)

### Testing (v1.0.0)

- 63-tool E2E matrix on Minikube: PASS=63
- 68 tools validated on GKE: PASS=68 (63 via main matrix + 5 via smoke test)
- 11-test auth + audit integration suite
- 3-test role model unit tests

See K8sCortex_Proof_of_Validation.html for full cloud validation details.
