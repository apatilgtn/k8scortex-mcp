import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { createAuthMiddleware, extractRoles, loadAuthConfig } from "../src/auth.js";
import { userContext, UserContext } from "../src/context.js";

describe("loadAuthConfig", () => {
  it("throws when auth is enabled without an identity provider", () => {
    expect(() => loadAuthConfig({})).toThrow(/OIDC_ISSUER/);
  });

  it("requires an audience with a generic issuer", () => {
    expect(() => loadAuthConfig({ OIDC_ISSUER: "https://idp.example.com" })).toThrow(/OIDC_AUDIENCE/);
  });

  it("maps legacy Entra settings to an OIDC config", () => {
    const cfg = loadAuthConfig({ ENTRA_TENANT_ID: "t1", ENTRA_CLIENT_ID: "c1" });
    expect(cfg.mode).toBe("oidc");
    if (cfg.mode !== "oidc") return;
    expect(cfg.oidc.issuer).toContain("https://login.microsoftonline.com/t1/v2.0");
    expect(cfg.oidc.audience).toBe("c1");
    expect(cfg.oidc.jwksUri).toBe("https://login.microsoftonline.com/t1/discovery/v2.0/keys");
  });

  it("rejects a malformed role map", () => {
    expect(() => loadAuthConfig({ TEST_JWT_SECRET: "s", OIDC_ROLE_MAP: "[1]" })).toThrow(/OIDC_ROLE_MAP/);
  });
});

describe("extractRoles", () => {
  it("reads claims whose names contain colons or dots verbatim", () => {
    expect(extractRoles({ "cognito:groups": ["sre"] }, "cognito:groups", {})).toEqual(["sre"]);
  });

  it("follows dotted paths and applies the role map", () => {
    const claims = { realm_access: { roles: ["k8s-admins", "developer"] } };
    expect(extractRoles(claims, "realm_access.roles", { "k8s-admins": "platform-engineer" }))
      .toEqual(["platform-engineer", "developer"]);
  });

  it("splits space-delimited string claims", () => {
    expect(extractRoles({ scope: "developer sre" }, "scope", {})).toEqual(["developer", "sre"]);
  });
});

describe("OIDC middleware with a JWKS endpoint", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
  let server: Server;
  let issuer: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/openid-configuration") res.end(JSON.stringify({ jwks_uri: `${issuer}/jwks` }));
      else if (req.url === "/jwks") res.end(JSON.stringify({ keys: [jwk] }));
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => { server.close(); });

  function sign(claims: object, options: jwt.SignOptions = {}) {
    return jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: "test-key", issuer, audience: "k8scortex", expiresIn: "5m", ...options });
  }

  function run(token: string | undefined, env: NodeJS.ProcessEnv = {}) {
    const middleware = createAuthMiddleware(loadAuthConfig({ OIDC_ISSUER: issuer, OIDC_AUDIENCE: "k8scortex", ...env }));
    return new Promise<{ status?: number; user?: UserContext }>((resolve) => {
      const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
      const res: any = { status: (code: number) => ({ send: () => resolve({ status: code }) }) };
      middleware(req, res, () => resolve({ user: userContext.getStore() }));
    });
  }

  it("accepts a token signed by the issuer and maps groups to roles", async () => {
    const token = sign({ sub: "user-1", groups: ["platform-admins"] });
    const result = await run(token, { OIDC_ROLES_CLAIM: "groups", OIDC_ROLE_MAP: '{"platform-admins":"platform-engineer"}' });
    expect(result.user).toEqual({ oid: "user-1", roles: ["platform-engineer"] });
  });

  it("rejects a token for a different audience", async () => {
    expect((await run(sign({ sub: "u" }, { audience: "other-app" }))).status).toBe(403);
  });

  it("rejects a token from a different issuer", async () => {
    expect((await run(sign({ sub: "u" }, { issuer: "https://evil.example.com" }))).status).toBe(403);
  });

  it("rejects a symmetric token in OIDC mode", async () => {
    const token = jwt.sign({ sub: "u" }, "shared-secret", { issuer, audience: "k8scortex" });
    expect((await run(token)).status).toBe(403);
  });

  it("returns 401 when no bearer token is sent", async () => {
    expect((await run(undefined)).status).toBe(401);
  });
});
