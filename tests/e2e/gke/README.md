# GKE end-to-end matrix

Runs every K8sCortex tool, both GKE-capable cluster providers and per-cluster policies against a real
GKE cluster. It covers what the [KWOK matrix](../kwok/README.md) cannot: the `gke` credential
provider, real kube-system addons, real pod logs and metrics, real evictions, and GKE's own labels.

The cluster is registered twice through `CLUSTERS_CONFIG`:

| Cluster | Provider | Credentials |
|---|---|---|
| `gke-adc` | `gke` | Application Default Credentials; endpoint and CA from the GKE API |
| `gke-kubeconfig` | `kubeconfig` | The context from `gcloud container clusters get-credentials` (`gke-gcloud-auth-plugin`) |

## Cluster

A 1-node e2-standard-2 zonal cluster plus a 1-node spot pool, which is the drain target. The default pool
is never cordoned or drained.

```bash
gcloud container clusters create k8scortex-test --zone us-central1-a --num-nodes 1 \
  --machine-type e2-standard-2 --disk-size 30 --workload-pool=PROJECT.svc.id.goog
gcloud container node-pools create spot-pool --cluster k8scortex-test --zone us-central1-a \
  --spot --num-nodes 1 --machine-type e2-small --disk-size 30 --workload-metadata=GKE_METADATA
gcloud container clusters get-credentials k8scortex-test --zone us-central1-a
gcloud auth application-default login     # for gke-adc
```

The identity needs `container.clusters.get` and enough Kubernetes RBAC to create the fixtures
(the cluster creator's `roles/container.admin` is enough).

## Run

```bash
export GKE_CONTEXT=gke_PROJECT_us-central1-a_k8scortex-test
export GKE_PROJECT=PROJECT GKE_LOCATION=us-central1-a GKE_CLUSTER=k8scortex-test
npm run test:e2e:gke                                             # seed, build, run all suites
SUITES=tools TOOLS_CLUSTER=gke-kubeconfig npx tsx tests/e2e/gke/run-gke.ts   # without ADC
```

| Variable | Default | |
|---|---|---|
| `SUITES` | `providers,tools,policies` | Suites to run |
| `TOOLS_CLUSTER` | `gke-adc` | Which registration the tools suite targets |
| `GKE_DRAIN_POOL` | `spot-pool` | Node pool whose node is cordoned, tainted and drained |
| `RESULTS_FILE` | `e2e-gke-results.json` | Results JSON |

Suites mutate the fixtures, so re-run `tests/e2e/gke/setup.sh "$GKE_CONTEXT"` before a full re-run
(`npm run test:e2e:gke` does this). Delete the cluster afterwards:
`gcloud container clusters delete k8scortex-test --zone us-central1-a`.
