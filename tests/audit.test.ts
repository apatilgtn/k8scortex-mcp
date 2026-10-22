import { describe, expect, it } from "vitest";
import { redactArgs } from "../src/audit.js";

describe("redactArgs", () => {
  it("redacts every value except identifiers for secret tools", () => {
    const out = redactArgs("create_secret", {
      namespace: "app", secretName: "db", stringData: { password: "hunter2" }, yamlManifest: "kind: Secret", dryRun: false,
    });
    expect(out).toEqual({ namespace: "app", secretName: "db", stringData: "[REDACTED]", yamlManifest: "[REDACTED]", dryRun: false });
  });

  it("redacts sensitive keys at any depth for other tools", () => {
    const out = redactArgs("create_deployment", {
      name: "web",
      env: [{ name: "API_TOKEN", value: "abc" }],
      nested: { auth: { password: "p", token: "t" } },
    });
    expect(out.name).toBe("web");
    expect(out.env[0]).toEqual({ name: "API_TOKEN", value: "[REDACTED]" });
    expect(out.nested.auth).toEqual({ password: "[REDACTED]", token: "[REDACTED]" });
  });

  it("leaves non-sensitive arguments untouched", () => {
    const args = { namespace: "default", replicas: 3 };
    expect(redactArgs("scale_deployment", args)).toEqual(args);
  });
});
