# ADR 001: Tool Taxonomy

## Status
Proposed

## Context
KubeNexus needs to expose a distinct set of Kubernetes operations to developers, agents, and pipelines via the Model Context Protocol (MCP). To ensure security, usability, and maintainability, we must define exactly what tools are available, what inputs they accept, and what outputs they return, while categorizing them into logical domains based on caller authorization profiles.

## Decision
We categorize the tools into five domains, each with defined access requirements:

1. **Workload Visibility** (Available to all authenticated users)
   - `list_pods`: Lists pods in a namespace.
   - `get_pod_logs`: Retrieves logs for a specific pod.
   - `describe_deployment`: Shows details of a deployment.
   - `list_nodes`: Lists cluster nodes.

2. **Deployment Operations** (Requires `platform-engineer` or `release-manager` role)
   - `scale_deployment`: Scales replicas for a deployment.
   - `restart_pod`: Deletes a pod to force a restart.
   - `rollback_release`: Rolls back a deployment to a previous revision.
   - *Note: All destructive operations must support a `dryRun` flag defaulting to true.*

3. **Configuration and Policy** (Requires `team-lead` role and above)
   - `get_configmap`: Reads data from a ConfigMap.
   - `describe_namespace_quota`: Reads resource quotas.
   - `list_events`: Lists recent cluster events.

4. **Observability Bridging** (Requires `sre` or `on-call` role)
   - `get_hpa_status`: Retrieves Horizontal Pod Autoscaler metrics.
   - `list_warning_events`: Filters cluster events for warnings.
   - `get_node_pressure`: Analyzes node resource pressure.

5. **Multi-cluster Context** (Requires `sre` or `platform-engineer` role)
   - Handled globally via a `cluster` parameter across tools.

## Consequences
- Requires strict enforcement of tool-level RBAC based on the caller's identity claims.
- The `dryRun` requirement forces agents to explicitly request destructive actions.
