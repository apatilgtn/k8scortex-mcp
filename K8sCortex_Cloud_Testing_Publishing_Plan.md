# K8sCortex Cloud Testing and Publishing Plan

## 1) Executive verdict

Current status: NOT ready for broad/public publish.

The project is close to an internal preview release, but it is not yet at production-grade publish quality because of deployment manifest mismatches, incomplete release automation, and missing validation for high-risk cluster-admin operations.

## 2) Publish bars

### Internal Preview (private team release)
- Build passes
- Core tools function in at least one cluster
- Auth/RBAC path is validated in non-dev mode
- Critical manifest mismatches fixed
- Audit logging validated end-to-end

### Public/External Publish
- Multi-cloud conformance (AKS, EKS, GKE)
- Security review and threat model sign-off
- Formal CI with unit/integration/e2e tests
- Release versioning/changelog/support policy
- Docs and tool catalog match runtime behavior exactly

## 3) Evidence-based readiness assessment

### Strengths
- TypeScript build currently succeeds.
- Tool set is broad and useful for operations workflows.
- Dry-run defaults exist for many mutating tools.
- Auth, role checks, and audit logging are implemented.
- Dual transport support exists (SSE and stdio).

### Blocking gaps (must-fix before publish)
- Kubernetes manifest naming mismatch:
  - deployment.yaml deploys Deployment name kubenexus-mcp-server
  - hpa.yaml targets Deployment name kubenexus
  - Result: HPA cannot target the deployed workload.
- ServiceAccount mismatch:
  - deployment.yaml uses serviceAccountName kubenexus-sa
  - rbac.yaml creates ServiceAccount kubenexus
  - Result: RBAC binding mismatch / pod identity risk.
- Documentation drift:
  - README and docs mention 14 tools, while source includes a much larger tool surface.
  - This is a governance and operator risk.
- No formal CI quality gates:
  - package.json has no test/lint scripts and no automated publish gate.
- Node drain semantics are simplified:
  - Current drain implementation deletes pods directly and does not model full kubectl drain safety behavior (eviction/PDB-aware waiting and explicit safeguards).

## 4) Cloud testing strategy

### Phase A: Local and single-cluster hardening (1-2 days)
- Verify auth-enabled flow (DISABLE_AUTH=false) with real Entra token validation.
- Validate all read-only tools in a non-admin namespace.
- Validate mutating tools in dryRun=true and dryRun=false paths.
- Validate audit records for success, failure, and denied outcomes.
- Validate rollout/restart/scale flows against a sample app.

Exit criteria:
- 100% tool invocation smoke pass in one cluster.
- Zero deployment manifest mismatches.

### Phase B: Multi-cloud conformance (3-5 days)
Run the same suite against:
- AKS (baseline)
- EKS
- GKE

For each cloud:
- Connectivity and cluster registration test
- RBAC least-privilege behavior by role tier
- Tool compatibility for workload, jobs, networking, autoscaling, and node operations
- Failure-mode tests (missing namespace/resource, permission denied, stale kubeconfig)

Exit criteria:
- All P0 tools pass in all 3 clouds.
- P1 tools pass in at least 2 clouds with known exceptions documented.

### Phase C: Reliability and scale tests (2-3 days)
- Run sustained MCP call load (read-heavy and mixed workloads).
- Measure p95/p99 latency and error rates against stated SLOs.
- Validate behavior during API throttling and transient failures.
- Validate cache TTL and credential rotation behavior.

Exit criteria:
- Meets SLO targets from docs/slos.md.
- No memory leak or runaway retry behavior.

### Phase D: Security and compliance validation (2-3 days)
- Verify no auth bypass in production deployment.
- Validate least-privilege RBAC in cluster manifests.
- Validate pod hardening settings (non-root, read-only fs, seccomp, resources, probes).
- Review audit log completeness and tamper resistance pipeline.

Exit criteria:
- Security review sign-off by platform/security owner.

## 5) Publishing checklist

### P0 (required before any publish)
- Fix Deployment/HPA name mismatch.
- Fix ServiceAccount mismatch between deployment and RBAC.
- Add CI pipeline with at least: build + test + typecheck gate.
- Add test script matrix and minimum smoke tests.
- Update docs so tool inventory and behavior match code.
- Pin and document versioning/release procedure.

### P1 (required before public publish)
- Improve drain behavior toward eviction/PDB-safe semantics.
- Add request/response validation and standardized error envelope.
- Add rate limiting and per-tool timeout controls.
- Add SBOM/dependency scan and signed release artifacts.

## 6) Suggested release decision

- Today: Internal alpha only.
- After P0 closure: Internal beta (controlled users).
- After P1 closure + 2 weeks stable operation: Public publish candidate.

## 7) Official Kubernetes guidance alignment

Yes, reviewing official Kubernetes guidance is the correct step and should stay in the release process.

Use these references in your publish gate:
- Kubernetes API dry-run behavior and authorization parity
- RBAC least-privilege and resource/subresource scoping
- Drain/eviction expectations for safe node maintenance behavior

This ensures MCP tool behavior matches operator expectations from kubectl and upstream API semantics.
