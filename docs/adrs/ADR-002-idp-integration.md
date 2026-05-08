# ADR 002: Identity Provider (IDP) Integration

## Status
Proposed

## Context
KubeNexus acts as a central control plane for Kubernetes operations. We must strictly verify the identity of callers (humans and agents). Callers originate from multiple environments, but the core organizational identity provider is Microsoft Entra ID.

## Decision
We will use **Entra ID OIDC tokens** for primary authentication.

- All clients connecting to the KubeNexus MCP server must provide a short-lived Entra ID token in the `Authorization` header.
- For non-Azure callers (e.g., AWS workloads or automated agents outside Azure), we will leverage Entra ID workload identity federation or issue service principal tokens.
- KubeNexus will validate the token signature against the Entra ID JWKS endpoint.

## Consequences
- Requires provisioning an App Registration in Entra ID for KubeNexus.
- Simplifies mapping to organizational roles (groups and app roles can be attached directly to the token claims).
- Adds a dependency on Entra ID availability.
