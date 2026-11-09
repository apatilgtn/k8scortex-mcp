import { describe, expect, it } from "vitest";
import { authorize, checkClusterPolicies, isAuthorized, isMutatingTool } from "../src/roles.js";

describe("isAuthorized", () => {
  it("allows higher role for lower-privilege tool", () => {
    expect(isAuthorized(["platform-engineer"], "list_pods")).toBe(true);
  });

  it("blocks lower role for higher-privilege tool", () => {
    expect(isAuthorized(["developer"], "delete_namespace")).toBe(false);
  });

  it("allows ci-pipeline scoped override", () => {
    expect(isAuthorized(["ci-pipeline"], "describe_deployment")).toBe(true);
  });
});

describe("authorize", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("treats %s as an unknown tool, not an Object.prototype member", (tool) => {
    expect(authorize(["platform-engineer"], tool)).toEqual({ allowed: false, reason: `Unknown tool '${tool}'` });
  });

  it("names only known roles in the reason, never IdP groups passed through from the token", () => {
    const result = authorize(["developer", "3f2b9c1e-group-guid", "Finance-All-Staff"], "scale_deployment");
    expect(result).toEqual({ allowed: false, reason: "Requires role release-manager or higher; caller has developer" });
  });

  it("says no recognised roles when the token carries only unmapped groups", () => {
    expect(authorize(["some-group"], "list_pods")).toEqual({ allowed: false, reason: "Requires role developer or higher; caller has no recognised roles" });
  });

  it("explains ci-pipeline's fixed allowlist instead of implying it can rank up", () => {
    expect(authorize(["ci-pipeline"], "scale_deployment")).toEqual({
      allowed: false,
      reason: "Role ci-pipeline may only call describe_deployment, list_events; scale_deployment requires role release-manager or higher",
    });
    expect(authorize(["ci-pipeline"], "list_events")).toEqual({ allowed: true });
  });
});

describe("isMutatingTool", () => {
  it.each(["scale_deployment", "rollout_undo", "drain_node", "remove_taint", "sync_gitops_app", "set_resource_limits", "create_secret"])(
    "classifies %s as mutating", (tool) => expect(isMutatingTool(tool)).toBe(true));

  it.each(["list_pods", "rollout_status", "get_gitops_diff", "compare_clusters", "describe_namespace_quota", "get_effective_permissions"])(
    "classifies %s as read-only", (tool) => expect(isMutatingTool(tool)).toBe(false));
});

describe("checkClusterPolicies", () => {
  const prod = { name: "prod-eks", labels: { env: "prod" } };
  const dev = { name: "dev-eks", labels: { env: "dev" } };

  it("allows everything when no policy matches", () => {
    expect(checkClusterPolicies(["release-manager"], "scale_deployment", dev, [{ match: "prod-*", minRole: "sre" }]).allowed).toBe(true);
  });

  it("raises the role required for mutating tools on matching clusters", () => {
    const policies = [{ match: "prod-*", minRole: "sre", appliesTo: "mutating" as const }];
    expect(checkClusterPolicies(["release-manager"], "scale_deployment", prod, policies).allowed).toBe(false);
    expect(checkClusterPolicies(["sre"], "scale_deployment", prod, policies).allowed).toBe(true);
    // Read-only tools are unaffected by a mutating-only policy
    expect(checkClusterPolicies(["developer"], "list_pods", prod, policies).allowed).toBe(true);
  });

  it("matches clusters by labels", () => {
    const policies = [{ labels: { env: "prod" }, minRole: "platform-engineer" }];
    expect(checkClusterPolicies(["sre"], "list_pods", prod, policies).allowed).toBe(false);
    expect(checkClusterPolicies(["sre"], "list_pods", dev, policies).allowed).toBe(true);
  });

  it("denies listed tools for every role", () => {
    const result = checkClusterPolicies(["platform-engineer"], "drain_node", prod, [{ match: "prod-*", denyTools: ["drain_node"] }]);
    expect(result).toEqual({ allowed: false, reason: "drain_node is disabled on cluster 'prod-eks' by policy" });
  });

  it("never grants access the global table denies", () => {
    // A low minRole must not let a developer run a platform-engineer tool
    expect(checkClusterPolicies(["developer"], "delete_namespace", dev, [{ match: "*", minRole: "developer" }]).allowed).toBe(true);
    expect(isAuthorized(["developer"], "delete_namespace")).toBe(false);
  });
});
