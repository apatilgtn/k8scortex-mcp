import { appendFileSync } from "fs";
import { join } from "path";

// In stdio mode, stdout is the MCP protocol channel — NEVER write to it.
// Audit logs go to stderr (visible in Claude Desktop logs) and optionally to a log file.
const LOG_FILE = process.env.AUDIT_LOG_FILE || join(process.cwd(), "audit.log");
const IS_STDIO = !process.env.PORT; // Stdio mode when no HTTP port is set

const REDACTED = "[REDACTED]";

// Argument keys whose values may carry secret material, matched case-insensitively at any depth.
const SENSITIVE_KEYS = new Set(["data", "stringdata", "value", "values", "password", "token", "secret", "yamlmanifest"]);

// Tools whose arguments are redacted entirely except for these identifying keys.
const SECRET_TOOLS = new Set(["create_secret", "update_secret"]);
const SECRET_TOOL_SAFE_KEYS = new Set(["namespace", "secretName", "dryRun", "cluster", "_cluster"]);

function redactValue(value: any, depth = 0): any {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => redactValue(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

export function redactArgs(toolName: string, args: any): any {
  if (!args || typeof args !== "object") return args;
  if (SECRET_TOOLS.has(toolName)) {
    return Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, SECRET_TOOL_SAFE_KEYS.has(k) ? v : REDACTED])
    );
  }
  return redactValue(args);
}

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
    arguments: redactArgs(toolName, args),
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
