import { appendFileSync } from "fs";
import { join } from "path";

// In stdio mode, stdout is the MCP protocol channel — NEVER write to it.
// Audit logs go to stderr (visible in Claude Desktop logs) and optionally to a log file.
const LOG_FILE = process.env.AUDIT_LOG_FILE || join(process.cwd(), "audit.log");
const IS_STDIO = !process.env.PORT; // Stdio mode when no HTTP port is set

export function logAuditAction(
  userOID: string,
  toolName: string,
  args: any,
  status: "success" | "failure" | "denied",
  errorMessage?: string
) {
  const auditRecord = {
    timestamp: new Date().toISOString(),
    event: "ToolInvocation",
    userOid: userOID,
    tool: toolName,
    arguments: args,
    status,
    ...(errorMessage ? { errorMessage } : {}),
  };

  const line = JSON.stringify(auditRecord) + "\n";

  if (IS_STDIO) {
    // stdio mode: write to stderr (Claude Desktop captures this as logs)
    process.stderr.write(line);
  } else {
    // HTTP/SSE mode: write to stdout for log aggregation pipelines
    process.stdout.write(line);
  }

  // Always append to the local audit log file
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Non-fatal — file logging is best-effort
  }
}
