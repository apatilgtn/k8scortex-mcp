# ADR 004: Multi-cluster Credential Management

## Status
Proposed

## Context
In Phase 3, KubeNexus must target operations across Azure AKS, AWS EKS, and GCP GKE clusters dynamically based on the tool's `cluster` parameter. KubeNexus runs in a central cluster but requires valid `kubeconfig` files or equivalent credentials to authenticate with remote clusters.

## Decision
We will use **Azure Key Vault** as the central repository for remote cluster credentials.

- The KubeNexus deployment will use the Azure Key Vault Provider for Secrets Store CSI Driver.
- Kubeconfigs for EKS and GKE will be stored as secrets in Key Vault.
- The KubeNexus application will read these credentials dynamically at request time to establish a Kubernetes client instance.
- A caching layer will keep clients in memory, but secrets will be periodically re-read to support transparent credential rotation without server restarts.

## Consequences
- High reliance on Azure Key Vault uptime.
- Requires network connectivity (PrivateLink/Transit Gateway) from the AKS hub cluster to the remote EKS/GKE API servers.
- Eliminates the need to bake multi-cloud credentials into the KubeNexus container image or static config maps.
