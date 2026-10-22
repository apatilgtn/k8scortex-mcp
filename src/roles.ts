// ADR 003: Role Model Definitions
import type { ClusterEntry, ClusterPolicy } from './clusters/types.js';

export type Role = 'developer' | 'team-lead' | 'release-manager' | 'sre' | 'platform-engineer' | 'ci-pipeline';

const ROLE_HIERARCHY: Record<Role, number> = {
  'developer': 1,
  'team-lead': 2,
  'release-manager': 3,
  'sre': 4,
  'platform-engineer': 5,
  'ci-pipeline': 0, // Separate scope
};

// Map each tool to its required minimum role
export const TOOL_ROLE_REQUIREMENTS: Record<string, Role> = {
  // Developer (Visibility & basic troubleshooting)
  'list_pods': 'developer',
  'get_pod_logs': 'developer',
  'describe_deployment': 'developer',
  'describe_pod': 'developer',
  'list_statefulsets': 'developer',
  'describe_statefulset': 'developer',
  'list_daemonsets': 'developer',
  'describe_daemonset': 'developer',
  'list_nodes': 'developer',
  'list_persistent_volume_claims': 'developer',
  'list_k8s_resources': 'developer',
  'get_k8s_resource': 'developer',
  'list_node_pools': 'developer',
  'get_node_pool_detail': 'developer',
  'get_workload_identity_config': 'developer',
  'validate_workload_identity': 'developer',
  'list_pod_disruption_budgets': 'developer',
  'get_pdb_status': 'developer',
  'list_vpas': 'developer',
  'get_vpa_recommendation': 'developer',
  'list_storage_classes': 'developer',
  'get_storage_class': 'developer',
  'get_addon_health': 'developer',
  'list_limit_ranges': 'developer',
  'list_clusters': 'developer',
  'get_cluster_info': 'developer',
  'list_jobs': 'developer',
  'list_cronjobs': 'developer',
  'get_resource_recommendations': 'developer',
  'get_gitops_app_status': 'developer',
  'get_gitops_diff': 'developer',
  'compare_clusters': 'developer',
  'list_flux_kustomizations': 'developer',
  'list_flux_helm_releases': 'developer',
  'get_flux_helm_release': 'developer',
  'list_flux_sources': 'developer',
  'list_flux_alerts': 'developer',
  'list_ingresses': 'developer',
  'get_service_endpoints': 'developer',
  'rollout_status': 'developer',

  // Team Lead (Config, Quotas, Events)
  'get_configmap': 'team-lead',
  'describe_namespace_quota': 'team-lead',
  'list_events': 'team-lead',
  'get_effective_permissions': 'team-lead',
  'create_namespace': 'team-lead',
  'create_configmap': 'team-lead',
  'update_configmap': 'team-lead',

  // Release Manager (Scaling, restarts, job execution, workload creation)
  'scale_deployment': 'release-manager',
  'restart_pod': 'release-manager',
  'create_deployment': 'release-manager',
  'delete_deployment': 'release-manager',
  'create_horizontal_pod_autoscaler': 'release-manager',
  'create_job': 'release-manager',
  'suspend_cronjob': 'release-manager',
  'resume_cronjob': 'release-manager',
  'create_service': 'release-manager',
  'update_ingress': 'release-manager',
  'set_resource_limits': 'release-manager',
  'sync_gitops_app': 'release-manager',
  'suspend_flux_resource': 'release-manager',
  'resume_flux_resource': 'release-manager',
  'rollout_undo': 'release-manager',

  // SRE (Deep observability, secrets, policies)
  'get_hpa_status': 'sre',
  'list_warning_events': 'sre',
  'get_node_pressure': 'sre',
  'create_secret': 'sre',
  'update_secret': 'sre',
  'create_network_policy': 'sre',

  // Platform Engineer (Destructive operations)
  'delete_namespace': 'platform-engineer',
  'get_cluster_resource_utilisation': 'platform-engineer',
  'cordon_node': 'platform-engineer',
  'uncordon_node': 'platform-engineer',
  'drain_node': 'platform-engineer',
  'taint_node': 'platform-engineer',
  'remove_taint': 'platform-engineer',
};

const MUTATING_TOOL_PATTERN = /^(create|update|delete|scale|restart|suspend|resume|sync|set|cordon|uncordon|drain|taint|remove)_|^rollout_undo$/;

/** True for tools that change cluster state (including their dry-run mode). */
export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOL_PATTERN.test(toolName);
}

/**
 * Checks if the user's roles from Entra ID satisfy the tool's requirement.
 */
export function isAuthorized(userRoles: string[] = [], toolName: string): boolean {
  // ci-pipeline handles explicit scopes and might bypass standard hierarchy for deployment operations
  if (userRoles.includes('ci-pipeline') && ['describe_deployment', 'list_events'].includes(toolName)) {
    return true;
  }

  const requiredRole = TOOL_ROLE_REQUIREMENTS[toolName];
  if (!requiredRole) return false; // Unknown tool

  const requiredLevel = ROLE_HIERARCHY[requiredRole];

  // User has access if any of their roles meet or exceed the required level
  return userRoles.some(role => {
    const userLevel = ROLE_HIERARCHY[role as Role] || 0;
    return userLevel >= requiredLevel;
  });
}

export function isKnownRole(role: string): role is Role {
  return Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, role);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function policyMatches(policy: ClusterPolicy, cluster: Pick<ClusterEntry, 'name' | 'labels'>): boolean {
  if (policy.match && !globToRegExp(policy.match).test(cluster.name)) return false;
  return Object.entries(policy.labels ?? {}).every(([k, v]) => cluster.labels?.[k] === v);
}

/**
 * Applies per-cluster policies on top of the global role table. Policies can only remove access:
 * denyTools blocks a tool outright, minRole raises the role needed on matching clusters.
 */
export function checkClusterPolicies(
  userRoles: string[] = [],
  toolName: string,
  cluster: Pick<ClusterEntry, 'name' | 'labels'>,
  policies: ClusterPolicy[] = []
): { allowed: true } | { allowed: false; reason: string } {
  const userLevel = Math.max(0, ...userRoles.map(r => (isKnownRole(r) ? ROLE_HIERARCHY[r] : 0)));
  for (const policy of policies) {
    if (!policyMatches(policy, cluster)) continue;
    if (policy.denyTools?.includes(toolName)) {
      return { allowed: false, reason: `${toolName} is disabled on cluster '${cluster.name}' by policy` };
    }
    const applies = policy.appliesTo !== 'mutating' || isMutatingTool(toolName);
    if (policy.minRole && applies && isKnownRole(policy.minRole) && userLevel < ROLE_HIERARCHY[policy.minRole]) {
      return { allowed: false, reason: `${toolName} on cluster '${cluster.name}' requires role ${policy.minRole} or higher` };
    }
  }
  return { allowed: true };
}
