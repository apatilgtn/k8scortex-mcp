# K8sCortex Full 51-Tool E2E Status

Date: 2026-05-06
Environment: minikube (context: minikube)
MCP mode: SSE over local dev server (`DISABLE_AUTH=true`)
Result summary: TOTAL=51, PASS=49, FAIL=2

## Per-tool status

| Tool | Status | Detail |
|---|---|---|
| list_pods | PASS | ok |
| get_pod_logs | PASS | ok |
| describe_deployment | PASS | ok |
| list_nodes | PASS | ok |
| list_statefulsets | PASS | ok |
| describe_statefulset | PASS | ok |
| list_daemonsets | PASS | ok |
| describe_daemonset | PASS | ok |
| scale_deployment | PASS | ok |
| restart_pod | PASS | ok |
| get_configmap | PASS | ok |
| describe_namespace_quota | PASS | ok |
| list_events | PASS | ok |
| list_persistent_volume_claims | PASS | ok |
| get_effective_permissions | PASS | ok |
| get_hpa_status | PASS | ok |
| list_warning_events | PASS | ok |
| get_node_pressure | PASS | ok |
| list_clusters | PASS | ok |
| get_cluster_info | PASS | ok |
| list_jobs | PASS | ok |
| create_job | PASS | ok |
| list_cronjobs | PASS | ok |
| suspend_cronjob | PASS | ok |
| resume_cronjob | PASS | ok |
| create_configmap | PASS | ok |
| update_configmap | PASS | ok |
| create_secret | PASS | ok |
| update_secret | PASS | ok |
| create_deployment | PASS | ok |
| delete_deployment | PASS | ok |
| create_namespace | PASS | ok |
| delete_namespace | PASS | ok |
| create_horizontal_pod_autoscaler | PASS | ok |
| create_service | PASS | ok |
| update_ingress | PASS | ok |
| create_network_policy | PASS | ok |
| set_resource_limits | PASS | ok |
| get_resource_recommendations | FAIL | Failed to fetch pod metrics. Make sure metrics-server is running. |
| get_cluster_resource_utilisation | FAIL | Failed to fetch node metrics. Make sure metrics-server is running. |
| cordon_node | PASS | ok |
| uncordon_node | PASS | ok |
| drain_node | PASS | ok |
| taint_node | PASS | ok |
| remove_taint | PASS | ok |
| get_gitops_app_status | PASS | ok |
| get_gitops_diff | PASS | ok |
| sync_gitops_app | PASS | ok |
| compare_clusters | PASS | ok |
| list_k8s_resources | PASS | ok |
| get_k8s_resource | PASS | ok |

## Notes

- The two failed tools depend on the Kubernetes metrics API (`metrics.k8s.io`).
- On minikube, enabling the metrics-server addon should resolve both failures.
- GitOps tools passed in this run because the `argocd` app lookup path in current implementation returns a handled response in this environment rather than throwing at the transport layer.
