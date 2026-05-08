#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { workloadTools, handleWorkloadTool } from "./tools/workload.js";
import { deploymentTools, handleDeploymentTool } from "./tools/deployment.js";
import { configurationTools, handleConfigurationTool } from "./tools/configuration.js";
import { observabilityTools, handleObservabilityTool } from "./tools/observability.js";
import { multiclusterTools, handleMulticlusterTool } from "./tools/multicluster.js";
import { jobTools, handleJobTool } from "./tools/jobs.js";
import { configManagementTools, handleConfigManagementTool } from "./tools/config_management.js";
import { networkTools, handleNetworkTool } from "./tools/network.js";
import { resourceIntelligenceTools, handleResourceIntelligenceTool } from "./tools/resource_intelligence.js";
import { clusterAdminTools, handleClusterAdminTool } from "./tools/cluster_admin.js";
import { workloadCreationTools, handleWorkloadCreationTool } from "./tools/workload_creation.js";
import { gitopsTools, handleGitOpsTool } from "./tools/gitops.js";
import { genericReadTools, handleGenericReadTool } from "./tools/generic_read.js";
import { cloudAwarenessTools, handleCloudAwarenessTool } from "./tools/cloud_awareness.js";
import { isAuthorized } from "./roles.js";
import { logAuditAction } from "./audit.js";
// Stdio mode: auth is not enforced — Claude Desktop manages process identity.
// All tool calls are attributed to the local user running the process.
const STUB_USER = { oid: "claude-desktop", roles: ["platform-engineer"] };
const server = new Server({ name: "K8sCortex", version: "1.0.0" }, { capabilities: { tools: {} } });
const allTools = [
    ...workloadTools,
    ...deploymentTools,
    ...configurationTools,
    ...observabilityTools,
    ...multiclusterTools,
    ...jobTools,
    ...configManagementTools,
    ...networkTools,
    ...resourceIntelligenceTools,
    ...clusterAdminTools,
    ...workloadCreationTools,
    ...gitopsTools,
    ...genericReadTools,
    ...cloudAwarenessTools,
];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const userOid = STUB_USER.oid;
    const roles = STUB_USER.roles;
    const cluster = args?.cluster || "default";
    if (!isAuthorized(roles, name)) {
        logAuditAction(userOid, name, args, "denied", "User lacks required role");
        throw new Error(`Unauthorized to invoke tool: ${name}`);
    }
    let result;
    let status = "success";
    let errorMessage;
    try {
        if (workloadTools.find(t => t.name === name)) {
            result = await handleWorkloadTool(name, args);
        }
        else if (deploymentTools.find(t => t.name === name)) {
            result = await handleDeploymentTool(name, args);
        }
        else if (configurationTools.find(t => t.name === name)) {
            result = await handleConfigurationTool(name, args);
        }
        else if (observabilityTools.find(t => t.name === name)) {
            result = await handleObservabilityTool(name, args);
        }
        else if (multiclusterTools.find(t => t.name === name)) {
            result = await handleMulticlusterTool(name, args);
        }
        else if (jobTools.some((t) => t.name === name)) {
            result = await handleJobTool(name, args);
        }
        else if (configManagementTools.some((t) => t.name === name)) {
            result = await handleConfigManagementTool(name, args);
        }
        else if (networkTools.some((t) => t.name === name)) {
            result = await handleNetworkTool(name, args);
        }
        else if (resourceIntelligenceTools.some((t) => t.name === name)) {
            result = await handleResourceIntelligenceTool(name, args);
        }
        else if (clusterAdminTools.some((t) => t.name === name)) {
            result = await handleClusterAdminTool(name, args);
        }
        else if (workloadCreationTools.find(t => t.name === name)) {
            result = await handleWorkloadCreationTool(name, args);
        }
        else if (gitopsTools.find(t => t.name === name)) {
            result = await handleGitOpsTool(name, args);
        }
        else if (genericReadTools.find(t => t.name === name)) {
            result = await handleGenericReadTool(name, args);
        }
        else if (cloudAwarenessTools.find(t => t.name === name)) {
            result = await handleCloudAwarenessTool(name, args);
        }
        else {
            throw new Error(`Tool not found: ${name}`);
        }
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
        logAuditAction(userOid, name, { ...args, _cluster: cluster }, status, errorMessage);
    }
    return result;
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr so it doesn't interfere with the MCP stdio protocol
    process.stderr.write("K8sCortex MCP server started (stdio mode)\n");
}
main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
});
