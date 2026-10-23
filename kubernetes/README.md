# Plain manifests

[`k8scortex.yaml`](k8scortex.yaml) is the [Helm chart](../charts/k8scortex) rendered with
[`example-values.yaml`](example-values.yaml): Entra ID sign-in mapped to K8sCortex roles, read-only
RBAC on the management cluster, a GKE and an EKS cluster in the registry, production policies and a
NetworkPolicy. Use it if you apply plain manifests; otherwise install the chart directly.

To adapt it, edit `example-values.yaml` (or copy it) and render again:

```bash
helm template k8scortex charts/k8scortex -n platform-mcp -f kubernetes/example-values.yaml > kubernetes/k8scortex.yaml
```

CI fails if `k8scortex.yaml` is out of date with the chart.
