# KubeNexus Publish Readiness Scorecard

Date: 2026-05-06 (updated with Tier-1 additions)
Target release: v1.0.0 (internal/public decision gate)

## Overall status

Overall: CONDITIONAL PASS for internal publish, CONDITIONAL FAIL for public publish.

Decision rule:
- Internal publish: allowed when all P0 controls pass.
- Public publish: allowed when all P0 and P1 controls pass.

## Control scorecard

| ID | Control | Priority | Status | Evidence | Owner |
|---|---|---|---|---|---|
| C-01 | Build compiles from clean checkout | P0 | PASS | `npm run build` succeeds | Engineering |
| C-02 | Manifest resource names aligned (Deployment/HPA/Service) | P0 | PASS | [kubernetes/deployment.yaml](kubernetes/deployment.yaml), [kubernetes/hpa.yaml](kubernetes/hpa.yaml), [kubernetes/service.yaml](kubernetes/service.yaml) now target `kubenexus` | Platform |
| C-03 | ServiceAccount aligned with RBAC bindings | P0 | PASS | [kubernetes/deployment.yaml](kubernetes/deployment.yaml), [kubernetes/rbac.yaml](kubernetes/rbac.yaml) both use `kubenexus` | Platform |
| C-04 | Release gate scripts exist (lint/typecheck/test/build) | P0 | PASS | [package.json](package.json) includes `release:gate` and component scripts | Engineering |
| C-05 | Automated test baseline exists | P0 | PASS | [tests/roles.test.ts](tests/roles.test.ts) with role model checks | Engineering |
| C-06 | Tool catalog docs match runtime inventory | P0 | PASS | [README.md](README.md) and [docs/developer-guide.md](docs/developer-guide.md) updated; [docs/tier1-implementation-log-may-2026.md](docs/tier1-implementation-log-may-2026.md) records all Tier-1 changes | Product + Engineering |
| C-07 | Auth enabled path validated in non-dev mode | P0 | FAIL | Not evidenced in automated test artifacts | Security + Engineering |
| C-08 | Audit events validated for success/failure/denied | P0 | FAIL | No test harness assertions yet | Security + Engineering |
| C-09 | Multi-cloud conformance (AKS/EKS/GKE) | P1 | FAIL | Not yet executed or documented | Platform |
| C-10 | Node drain semantics aligned with safe eviction patterns | P1 | FAIL | [src/tools/cluster_admin.ts](src/tools/cluster_admin.ts) uses simplified deletion flow | Platform + SRE |
| C-11 | Supply chain scan and artifact signing | P1 | FAIL | No SBOM/signing pipeline evidenced | Security |
| C-12 | Versioned release notes and support policy | P1 | FAIL | No formal release notes/support policy file present | Product |
| C-13 | Generic read gap mitigation for uncommon resources | P1 | PASS | [src/tools/generic_read.ts](src/tools/generic_read.ts) implements list/get for arbitrary kinds while keeping curated governed writes | Platform + Engineering |

## Publish recommendation

- Internal publish: Proceed after C-07 and C-08 are closed.
- Public publish: Do not publish until all P0 and P1 controls are PASS.

## Immediate actions (next 72 hours)

1. Add auth-enabled integration smoke test and audit-log assertion test.
2. Run and document release gate output in CI for reproducible publish decisions.
3. Add release notes and support policy for public launch readiness.

## Tool status (latest full E2E matrix)

Run context:
- Date: 2026-05-06 (Tier-1 tools added — 51→63)
- Command: `MCP_URL=http://localhost:3006/mcp npx tsx tests/e2e-all-63-minikube.ts`
- Result: `TOTAL=63 PASS=63 FAIL=0`
- Notes: 3 tools returned PASS via graceful skip (see details below)

| Tool | Status | Notes |
|---|---|---|
| list_pods | PASS | |
| get_pod_logs | PASS | |
| describe_deployment | PASS | |
| list_nodes | PASS | |
| list_statefulsets | PASS | |
| describe_statefulset | PASS | |
| list_daemonsets | PASS | |
| describe_daemonset | PASS | |
| scale_deployment | PASS | |
| restart_pod | PASS | |
| get_configmap | PASS | |
| describe_namespace_quota | PASS | |
| list_events | PASS | |
| list_persistent_volume_claims | PASS | |
| get_effective_permissions | PASS | |
| get_hpa_status | PASS | |
| list_warning_events | PASS | |
| get_node_pressure | PASS | |
| list_clusters | PASS | |
| get_cluster_info | PASS | |
| list_jobs | PASS | |
| create_job | PASS | |
| list_cronjobs | PASS | |
| suspend_cronjob | PASS | |
| resume_cronjob | PASS | |
| create_configmap | PASS | |
| update_configmap | PASS | |
| create_secret | PASS | |
| update_secret | PASS | |
| create_deployment | PASS | |
| delete_deployment | PASS | |
| create_namespace | PASS | |
| delete_namespace | PASS | |
| create_horizontal_pod_autoscaler | PASS | |
| create_service | PASS | |
| update_ingress | PASS | |
| create_network_policy | PASS | |
| set_resource_limits | PASS | |
| get_resource_recommendations | PASS | |
| get_cluster_resource_utilisation | PASS | |
| cordon_node | PASS | |
| uncordon_node | PASS | |
| drain_node | PASS | |
| taint_node | PASS | |
| remove_taint | PASS | |
| get_gitops_app_status | PASS | |
| get_gitops_diff | PASS | |
| sync_gitops_app | PASS | |
| compare_clusters | PASS | |
| list_k8s_resources | PASS | |
| get_k8s_resource | PASS | |
| list_node_pools | PASS | *(NEW Tier-1)* |
| get_node_pool_detail | PASS | *(NEW Tier-1) — skipped: no cloud node-pool label on Minikube; live on AKS/EKS/GKE* |
| get_workload_identity_config | PASS | *(NEW Tier-1)* |
| validate_workload_identity | PASS | *(NEW Tier-1)* |
| list_pod_disruption_budgets | PASS | *(NEW Tier-1)* |
| get_pdb_status | PASS | *(NEW Tier-1) — skipped: no PDB in fixture namespace; live when PDB present* |
| list_vpas | PASS | *(NEW Tier-1)* |
| get_vpa_recommendation | PASS | *(NEW Tier-1) — skipped: VPA CRD absent on Minikube; live when VPA installed* |
| list_storage_classes | PASS | *(NEW Tier-1)* |
| get_storage_class | PASS | *(NEW Tier-1)* |
| get_addon_health | PASS | *(NEW Tier-1)* |
| list_limit_ranges | PASS | *(NEW Tier-1)* |

