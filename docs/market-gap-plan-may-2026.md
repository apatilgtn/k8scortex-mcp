# KubeNexus Market Gap Plan (May 2026)

## Executive review

Your comparison is strong and credible. The key strategic point is correct:

- KubeNexus is a governed, org-grade Kubernetes MCP platform.
- The top open-source alternative leads on raw breadth (generic CRUD, pod exec), but not on governance controls.

This should be framed as a product split, not a winner-takes-all feature race.

## Current position summary

KubeNexus differentiators to keep leading with:

- OIDC identity validation on requests
- Tool-level RBAC model
- Per-call audit trail
- Dry-run defaults on high-risk actions
- Centralized credential model (Key Vault + cluster store)
- In-cluster deployment model for platform teams

Coverage improvements already completed:

- StatefulSet visibility
- DaemonSet visibility
- PVC status
- RBAC inspection
- Generic read for arbitrary resources
- Full tool matrix test run with 49/51 pass in minikube

## Remaining gaps: classify before acting

### Intentional non-goals for v1

1. Generic write for any resource
- Recommendation: Do not add in v1.
- Reason: Conflicts with governance-first design and least-privilege role story.
- Positioning: "KubeNexus intentionally curates write operations to keep changes auditable, reviewable, and role-safe."

2. Pod exec
- Recommendation: Do not add in v1.
- Reason: Requires interactive/session semantics, high security risk, and complex policy boundaries.
- Positioning: "Out of scope for v1; evaluate for v2 behind explicit policy controls and session-level guardrails."

### Practical gaps to improve next (without breaking philosophy)

1. Metrics-dependent resiliency
- Problem: 2 tools failed when metrics API unavailable.
- Action: Add graceful degradation and explicit diagnostics for missing metrics-server.
- Priority: P0.5 (immediately after v1 publish prep).

2. Documentation and launch artifact consistency
- Action: Keep market comparison, tool inventory, and known boundaries aligned across README, developer guide, and listing metadata.
- Priority: P0.

3. Test repeatability
- Action: Keep full 51-tool matrix in CI-ready form with environment tags (`minikube`, `auth-enabled`, `multicluster`).
- Priority: P0.

## Concrete implementation plan

## Phase A (pre-Smithery / pre-Show HN)

1. Publish boundary statement
- Add "Scope Boundaries" section to README:
  - Generic write: intentionally out of scope.
  - Pod exec: intentionally out of scope for v1.

2. Add metrics fallback behavior
- For metrics-based tools, return structured guidance:
  - status: degraded
  - reason: metrics API unavailable
  - remediation: enable metrics-server

3. Add deterministic test command
- Add npm script for full matrix run:
  - `test:e2e:minikube:all`
- Ensure output report includes per-tool status and failure reason.

## Phase B (v1.0.1)

1. Multi-environment matrix
- Run all-tool test suite in at least:
  - minikube
  - AKS dev cluster

2. Auth-enabled E2E path
- Add token-auth test profile (non-DISABLE_AUTH).

3. Listing-quality launch package
- Smithery description + capabilities table + known boundaries + quickstart.

## Phase C (v2 exploration)

1. Pod exec design RFC
- Session model
- Policy model (who/where/for how long)
- Full audit capture of commands
- Redaction controls

2. Optional controlled generic write RFC
- Allowlist of apiGroups/resources
- Namespace restrictions
- Approval/confirmation workflow
- Dry-run mandatory first pass

## Messaging to use publicly

"KubeNexus is not trying to be an ungoverned kubectl replacement. It is a governed Kubernetes MCP platform for organizations that need centralized access, role boundaries, and auditability."

"For v1, KubeNexus provides broad read coverage (including generic read) and curated safe writes. High-risk capabilities like generic write and pod exec are intentional scope boundaries."
