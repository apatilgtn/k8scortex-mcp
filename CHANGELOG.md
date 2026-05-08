# Changelog

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
