# ADR 003: Role Model

## Status
Proposed

## Context
Once a caller's identity is verified (ADR 002), KubeNexus needs a role-based access control (RBAC) model to determine which tools the caller is permitted to invoke (ADR 001).

## Decision
We will map Entra ID token claims (e.g., group IDs or explicit App Roles) to the following internal role model:

- `developer`: Read-only access to workload visibility tools.
- `team-lead`: Includes developer permissions, plus configuration and policy reads.
- `release-manager`: Includes team-lead permissions, plus deployment operations (scale, restart, rollback).
- `sre` / `on-call`: Includes release-manager permissions, plus observability bridging and cross-cluster operations.
- `platform-engineer`: Full access to all tools.
- `ci-pipeline`: Scoped access for deployment verification tools and automated rollback triggers.

The enforcement will be implemented via middleware checking required roles against the token claims. OPA/Gatekeeper will provide a secondary cluster-level defense for namespace operations.

## Consequences
- Requires Entra ID administrators to maintain group/role mappings.
- The MCP server needs a deterministic mapping from Entra ID Object IDs/Role Claims to these logical roles.
