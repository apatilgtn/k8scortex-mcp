const ROLE_HIERARCHY = {
    'developer': 1,
    'team-lead': 2,
    'release-manager': 3,
    'sre': 4,
    'platform-engineer': 5,
    'ci-pipeline': 0, // Separate scope
};
// Map each tool to its required minimum role
export const TOOL_ROLE_REQUIREMENTS = {
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
export function isMutatingTool(toolName) {
    return MUTATING_TOOL_PATTERN.test(toolName);
}
// ci-pipeline sits outside the hierarchy: it may call exactly these tools and nothing else
const CI_PIPELINE_TOOLS = ['describe_deployment', 'list_events'];
/** The minimum role for a tool, or undefined for unknown tools (never an inherited Object.prototype member). */
export function requiredRoleFor(toolName) {
    return Object.hasOwn(TOOL_ROLE_REQUIREMENTS, toolName) ? TOOL_ROLE_REQUIREMENTS[toolName] : undefined;
}
/**
 * Decides whether the caller's roles allow a tool, and if not, why. The reason is shown to the MCP client
 * and written to the audit log, so it names only roles K8sCortex knows: IdP groups passed through
 * from the token (often dozens of directory IDs) are left out.
 */
export function authorize(userRoles = [], toolName) {
    const requiredRole = requiredRoleFor(toolName);
    if (!requiredRole)
        return { allowed: false, reason: `Unknown tool '${toolName}'` };
    const knownRoles = userRoles.filter(isKnownRole);
    if (knownRoles.includes('ci-pipeline') && CI_PIPELINE_TOOLS.includes(toolName))
        return { allowed: true };
    // User has access if any of their roles meet or exceed the required level
    const requiredLevel = ROLE_HIERARCHY[requiredRole];
    if (knownRoles.some(role => ROLE_HIERARCHY[role] >= requiredLevel))
        return { allowed: true };
    if (knownRoles.length && knownRoles.every(role => role === 'ci-pipeline')) {
        return { allowed: false, reason: `Role ci-pipeline may only call ${CI_PIPELINE_TOOLS.join(', ')}; ${toolName} requires role ${requiredRole} or higher` };
    }
    return {
        allowed: false,
        reason: `Requires role ${requiredRole} or higher; caller has ${knownRoles.length ? knownRoles.join(', ') : 'no recognised roles'}`,
    };
}
/**
 * Checks if the user's roles from Entra ID satisfy the tool's requirement.
 */
export function isAuthorized(userRoles = [], toolName) {
    return authorize(userRoles, toolName).allowed;
}
export function isKnownRole(role) {
    return Object.prototype.hasOwnProperty.call(ROLE_HIERARCHY, role);
}
function globToRegExp(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}
function policyMatches(policy, cluster) {
    if (policy.match && !globToRegExp(policy.match).test(cluster.name))
        return false;
    return Object.entries(policy.labels ?? {}).every(([k, v]) => cluster.labels?.[k] === v);
}
/**
 * Applies per-cluster policies on top of the global role table. Policies can only remove access:
 * denyTools blocks a tool outright, minRole raises the role needed on matching clusters.
 */
export function checkClusterPolicies(userRoles = [], toolName, cluster, policies = []) {
    const userLevel = Math.max(0, ...userRoles.map(r => (isKnownRole(r) ? ROLE_HIERARCHY[r] : 0)));
    for (const policy of policies) {
        if (!policyMatches(policy, cluster))
            continue;
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
