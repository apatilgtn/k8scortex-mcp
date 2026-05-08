import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
import { authenticateToken } from "./auth.js";
import { isAuthorized } from "./roles.js";
import { logAuditAction } from "./audit.js";
import { userContext } from "./context.js";

const app = express();
const port = process.env.PORT || 3000;

// Initialize the MCP Server
const server = new Server(
  {
    name: "K8sCortex",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      ...workloadTools,
      ...deploymentTools,
      ...configurationTools,
      ...observabilityTools,
      ...multiclusterTools,
      ...jobTools,
      ...configManagementTools,
      ...workloadCreationTools,
      ...networkTools,
      ...resourceIntelligenceTools,
      ...clusterAdminTools,
      ...gitopsTools,
      ...genericReadTools,
      ...cloudAwarenessTools,
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const user = userContext.getStore();

  if (!user) {
    throw new Error("Authentication context lost");
  }

  const userOid = user.oid || user.sub || 'unknown-user';
  const roles = user.roles || [];
  const cluster = (args as any)?.cluster || 'default';

  if (!isAuthorized(roles, name)) {
    logAuditAction(userOid, name, args, 'denied', 'User lacks required role');
    throw new Error(`Unauthorized to invoke tool: ${name}`);
  }

  let result;
  let status: 'success' | 'failure' = 'success';
  let errorMessage: string | undefined;

  try {
    if (workloadTools.find(t => t.name === name)) {
      result = await handleWorkloadTool(name, args);
    } else if (deploymentTools.find(t => t.name === name)) {
      result = await handleDeploymentTool(name, args);
    } else if (configurationTools.find(t => t.name === name)) {
      result = await handleConfigurationTool(name, args);
    } else if (observabilityTools.find(t => t.name === name)) {
      result = await handleObservabilityTool(name, args);
    } else if (multiclusterTools.find(t => t.name === name)) {
      result = await handleMulticlusterTool(name, args);
    } else if (jobTools.find(t => t.name === name)) {
      result = await handleJobTool(name, args);
    } else if (configManagementTools.find(t => t.name === name)) {
      result = await handleConfigManagementTool(name, args);
    } else if (workloadCreationTools.find(t => t.name === name)) {
      result = await handleWorkloadCreationTool(name, args);
    } else if (networkTools.find(t => t.name === name)) {
      result = await handleNetworkTool(name, args);
    } else if (resourceIntelligenceTools.find(t => t.name === name)) {
      result = await handleResourceIntelligenceTool(name, args);
    } else if (clusterAdminTools.find(t => t.name === name)) {
      result = await handleClusterAdminTool(name, args);
    } else if (gitopsTools.find(t => t.name === name)) {
      result = await handleGitOpsTool(name, args);
    } else if (genericReadTools.find(t => t.name === name)) {
      result = await handleGenericReadTool(name, args);
    } else if (cloudAwarenessTools.find(t => t.name === name)) {
      result = await handleCloudAwarenessTool(name, args);
    } else {
      throw new Error(`Tool not found: ${name}`);
    }

    if (result && (result as any).isError) {
       status = 'failure';
       errorMessage = (result as any).content?.[0]?.text;
    }
  } catch (error: any) {
    status = 'failure';
    errorMessage = error.message;
    throw error;
  } finally {
    logAuditAction(userOid, name, { ...args, _cluster: cluster }, status, errorMessage);
  }

  return result;
});
// Tools registered logic above...

// Setup Express and SSE Transport
let transport: SSEServerTransport;

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get("/mcp", authenticateToken, async (req, res, next) => {
  try {
    if (transport) {
      await server.close().catch(() => {});
    }
    transport = new SSEServerTransport("/messages", res as any);
    await server.connect(transport);
  } catch (err) {
    console.error("Error connecting SSE transport:", err);
    res.status(500).send(String(err));
  }
});

app.post("/messages", authenticateToken, async (req, res) => {
  try {
    if (transport) {
      await transport.handlePostMessage(req, res as any);
    } else {
      res.status(400).send("Transport not established");
    }
  } catch (err) {
    console.error("Error handling POST message:", err);
    res.status(500).send(String(err));
  }
});

app.listen(port, () => {
  console.log(`K8sCortex MCP Server listening on port ${port}`);
});
