# KWOK end-to-end matrix

Runs every K8sCortex tool and the multi-cluster, policy, auth and audit scenarios against two local
[KWOK](https://kwok.sigs.k8s.io/) clusters. KWOK runs a real etcd, API server, controller-manager,
scheduler and metrics-server as local processes and simulates nodes and pods, so no Docker or cloud
account is needed.

| Context | Simulates | Fixtures |
|---|---|---|
| `kwok-dev` | GKE (node pools, spot, Workload Identity, PD CSI) | Argo CD app at revision `a1b2c3d4` |
| `kwok-prod` | EKS (node groups, spot, IRSA, EBS CSI) | Argo CD app at revision `e5f6a7b8` |

Both clusters get the same workloads (Deployment, StatefulSet, DaemonSets, HPA, VPA, PDB, CronJob,
Ingress, quota, limits), Flux Kustomization/HelmRelease/sources/alerts, simulated logs and metrics.

```bash
# needs kwokctl (v0.7+) and kubectl on PATH
npm run test:e2e:kwok                     # create clusters, build, run all suites
SUITES=tools,registry npx tsx tests/e2e/kwok/run-matrix.ts   # re-run selected suites
```

Results are written to `RESULTS_FILE` (default `e2e-results.json`). Suites mutate the clusters, so
re-create them (`tests/e2e/kwok/create-clusters.sh`) before a full re-run.

What KWOK cannot cover: real container behaviour (images are never pulled), the EKS and GKE
credential providers (unit-tested with mocks), and cloud-specific API behaviour.
