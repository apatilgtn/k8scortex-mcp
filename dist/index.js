import { randomUUID } from "node:crypto";
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateToken, loadAuthConfig } from "./auth.js";
import { userContext } from "./context.js";
import { buildMcpServer, allTools, SERVER_VERSION } from "./server.js";
// Fail fast on missing identity provider configuration instead of accepting unverifiable tokens
try {
    loadAuthConfig();
}
catch (err) {
    console.error(`K8sCortex startup aborted: ${err.message}`);
    process.exit(1);
}
const app = express();
app.use(express.json({ limit: "4mb" }));
const port = process.env.PORT || 3000;
const SESSION_IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS) || 30 * 60 * 1000;
// Active sessions keyed by session ID. Each session is bound to the user who created it.
const sessions = new Map();
const currentUser = () => userContext.getStore();
/** Returns the session if it exists and belongs to the caller; otherwise writes an error response. */
function lookupSession(sessionId, req, res) {
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        return undefined;
    }
    if (session.userOid !== req.user?.oid) {
        res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: "Session belongs to a different user" }, id: null });
        return undefined;
    }
    session.lastSeen = Date.now();
    return session;
}
// Close StreamableHTTP sessions that have been idle too long. SSE sessions end when their stream closes.
setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
    for (const [id, session] of sessions) {
        if (session.transport instanceof StreamableHTTPServerTransport && session.lastSeen < cutoff) {
            sessions.delete(id);
            session.transport.close().catch(() => { });
        }
    }
}, 60_000).unref();
app.get("/health", (req, res) => {
    res.status(200).send("OK");
});
app.get("/.well-known/mcp/server-card.json", (req, res) => {
    res.json({
        name: "K8sCortex",
        version: SERVER_VERSION,
        description: `Production-grade MCP server for Kubernetes — ${allTools.length} tools across GKE, AKS, EKS, OpenShift and Minikube with RBAC, audit logging, GitOps (ArgoCD + Flux), and multi-cluster support`,
        homepage: "https://github.com/apatilgtn/k8scortex-mcp",
        transport: ["streamable-http", "sse"],
        capabilities: { tools: {} },
    });
});
// StreamableHTTP transport (used by Smithery and newer MCP clients)
app.post("/mcp", authenticateToken, async (req, res) => {
    try {
        const sessionId = req.headers["mcp-session-id"];
        if (sessionId) {
            const session = lookupSession(sessionId, req, res);
            if (session)
                await session.transport.handleRequest(req, res, req.body);
            return;
        }
        const userOid = req.user.oid;
        const httpTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                sessions.set(id, { transport: httpTransport, userOid, lastSeen: Date.now() });
            },
        });
        httpTransport.onclose = () => {
            if (httpTransport.sessionId)
                sessions.delete(httpTransport.sessionId);
        };
        await buildMcpServer(currentUser).connect(httpTransport);
        await httpTransport.handleRequest(req, res, req.body);
    }
    catch (err) {
        console.error("StreamableHTTP error:", err);
        if (!res.headersSent)
            res.status(500).json({ error: err.message });
    }
});
// GET /mcp: StreamableHTTP notification stream when a session header is present, otherwise legacy SSE
app.get("/mcp", authenticateToken, async (req, res) => {
    try {
        const sessionId = req.headers["mcp-session-id"];
        if (sessionId) {
            const session = lookupSession(sessionId, req, res);
            if (session)
                await session.transport.handleRequest(req, res);
            return;
        }
        const sseTransport = new SSEServerTransport("/messages", res);
        sessions.set(sseTransport.sessionId, { transport: sseTransport, userOid: req.user.oid, lastSeen: Date.now() });
        res.on("close", () => sessions.delete(sseTransport.sessionId));
        await buildMcpServer(currentUser).connect(sseTransport);
    }
    catch (err) {
        console.error("Error connecting SSE transport:", err);
        if (!res.headersSent)
            res.status(500).send(String(err));
    }
});
app.delete("/mcp", authenticateToken, async (req, res) => {
    const session = lookupSession(req.headers["mcp-session-id"], req, res);
    if (session)
        await session.transport.handleRequest(req, res);
});
app.post("/messages", authenticateToken, async (req, res) => {
    try {
        const session = lookupSession(req.query.sessionId, req, res);
        if (!session)
            return;
        if (!(session.transport instanceof SSEServerTransport)) {
            res.status(400).send("Session is not an SSE session");
            return;
        }
        // express.json() has already consumed the body stream, so pass the parsed body through
        await session.transport.handlePostMessage(req, res, req.body);
    }
    catch (err) {
        console.error("Error handling POST message:", err);
        if (!res.headersSent)
            res.status(500).send(String(err));
    }
});
app.listen(port, () => {
    console.log(`K8sCortex MCP Server listening on port ${port}`);
});
