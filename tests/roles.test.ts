import { describe, expect, it } from "vitest";
import { isAuthorized } from "../src/roles.js";

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
