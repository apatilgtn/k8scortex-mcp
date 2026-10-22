import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { workloadTools, handleWorkloadTool } from "./tools/workload.js";
import { deploymentTools, handleDeploymentTool } from "./tools/deployment.js";
import { configurationTools, handleConfigurationTool } from "./tools/configuration.js";
import { observabilityTools, handleObservabilityTool } from "./tools/observability.js";
import { multiclusterTools, handleMulticlusterTool } from "./tools/multicluster.js";
import { jobTools, handleJobTool } from "./tools/jobs.js";
import { configManagementTools, handleConfigManagementTool } from "./tools/config_management.js";
import { workloadCreationTools, handleWorkloadCreationTool } from "./tools/workload_creation.js";
import { networkTools, handleNetworkTool } from "./tools/network.js";
import { resourceIntelligenceTools, handleResourceIntelligenceTool } from "./tools/resource_intelligence.js";
import { clusterAdminTools, handleClusterAdminTool } from "./tools/cluster_admin.js";
import { gitopsTools, handleGitOpsTool } from "./tools/gitops.js";
import { genericReadTools, handleGenericReadTool } from "./tools/generic_read.js";
import { cloudAwarenessTools, handleCloudAwarenessTool } from "./tools/cloud_awareness.js";
import { checkClusterPolicies, isAuthorized, isMutatingTool } from "./roles.js";
import { getClusterRegistry } from "./cluster-store.js";
import { logAuditAction } from "./audit.js";
import { userContext } from "./context.js";
const require = createRequire(import.meta.url);
export const SERVER_VERSION = require("../package.json").version;
const toolGroups = [
    [workloadTools, handleWorkloadTool],
    [deploymentTools, handleDeploymentTool],
    [configurationTools, handleConfigurationTool],
    [observabilityTools, handleObservabilityTool],
    [multiclusterTools, handleMulticlusterTool],
    [jobTools, handleJobTool],
    [configManagementTools, handleConfigManagementTool],
    [workloadCreationTools, handleWorkloadCreationTool],
    [networkTools, handleNetworkTool],
    [resourceIntelligenceTools, handleResourceIntelligenceTool],
    [clusterAdminTools, handleClusterAdminTool],
    [gitopsTools, handleGitOpsTool],
    [genericReadTools, handleGenericReadTool],
    [cloudAwarenessTools, handleCloudAwarenessTool],
];
export const allTools = toolGroups.flatMap(([tools]) => tools);
const toolHandlers = new Map(toolGroups.flatMap(([tools, handler]) => tools.map(t => [t.name, handler])));
/** The cluster names a tool call targets (undefined means the default cluster). */
function targetClusters(name, args) {
    if (name === "list_clusters")
        return [];
    if (name === "compare_clusters")
        return [args.clusterA, args.clusterB];
    return [args.cluster];
}
/**
 * Builds an MCP server exposing all K8sCortex tools.
 * getUser returns the caller for the current request; undefined means unauthenticated and every call is denied.
 */
export function buildMcpServer(getUser) {
    const srv = new Server({ name: "K8sCortex", version: SERVER_VERSION }, { capabilities: { tools: {} } });
    srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));
    srv.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name } = request.params;
        const args = request.params.arguments ?? {};
        const user = getUser();
        const userOid = user?.oid || "anonymous";
        if (!user || !isAuthorized(user.roles, name)) {
            logAuditAction(userOid, name, args, "denied", user ? "User lacks required role" : "No authenticated user");
            throw new Error(`Unauthorized to invoke tool: ${name}`);
        }
        const handler = toolHandlers.get(name);
        if (!handler)
            throw new Error(`Tool not found: ${name}`);
        // Resolve target clusters for per-cluster policies and the audit record. Without policies,
        // resolution errors (e.g. an unknown cluster) are left for the tool itself to report.
        const registry = getClusterRegistry();
        const resolutionErrors = [];
        const targets = (await Promise.all(targetClusters(name, args).map(c => registry.resolve(c).catch((err) => { resolutionErrors.push(err.message); return undefined; })))).filter((t) => !!t);
        const auditArgs = {
            ...args,
            _cluster: targets.map(t => t.name).join(",") || args.cluster || "default",
            ...(targets.length ? { _provider: [...new Set(targets.map(t => t.provider))].join(",") } : {}),
        };
        // Fail closed: a cluster whose policies cannot be evaluated is not accessible
        if (registry.policies.length && resolutionErrors.length) {
            logAuditAction(userOid, name, auditArgs, "denied", resolutionErrors[0]);
            throw new Error(`Unauthorized to invoke tool: ${name}. ${resolutionErrors[0]}`);
        }
        for (const target of targets) {
            const decision = checkClusterPolicies(user.roles, name, target, registry.policies);
            if (!decision.allowed) {
                logAuditAction(userOid, name, auditArgs, "denied", decision.reason);
                throw new Error(`Unauthorized to invoke tool: ${name}. ${decision.reason}`);
            }
        }
        let result;
        let status = "success";
        let errorMessage;
        try {
            // Writes must never silently land on whichever cluster happens to be the default
            if (isMutatingTool(name) && !args.cluster) {
                const clusters = await registry.list();
                if (clusters.length > 1) {
                    throw new Error(`${name} changes cluster state, so 'cluster' must be specified explicitly. Registered clusters: ${clusters.map(c => c.name).join(", ")}`);
                }
            }
            // Run the handler inside the caller's context so tools can make per-user decisions
            result = await userContext.run(user, () => handler(name, args));
            if (result?.isError) {
                status = "failure";
                errorMessage = result.content?.[0]?.text;
            }
        }
        catch (error) {
            status = "failure";
            errorMessage = error.message;
            throw error;
        }
        finally {
            logAuditAction(userOid, name, auditArgs, status, errorMessage);
        }
        return result;
    });
    return srv;
}
