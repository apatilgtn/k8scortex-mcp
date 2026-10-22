#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.js";
import { UserContext } from "./context.js";

// Stdio mode: auth is not enforced — Claude Desktop manages process identity.
// All tool calls are attributed to the local user running the process.
// K8SCORTEX_STDIO_ROLES (comma-separated) can lower privileges, e.g. "developer" for read-only use.
const LOCAL_USER: UserContext = {
  oid: "claude-desktop",
  roles: (process.env.K8SCORTEX_STDIO_ROLES || "platform-engineer").split(",").map(r => r.trim()).filter(Boolean),
};

const server = buildMcpServer(() => LOCAL_USER);

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
