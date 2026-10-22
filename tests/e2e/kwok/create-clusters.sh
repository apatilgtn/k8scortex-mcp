#!/usr/bin/env bash
# Creates two KWOK clusters (kwok-dev: GKE-like, kwok-prod: EKS-like) and seeds them with fixtures.
# Requires kwokctl and kubectl on PATH; runs every component as a local process (no Docker needed).
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p crds
[ -f crds/flux-install.yaml ] || curl -fsSLo crds/flux-install.yaml https://github.com/fluxcd/flux2/releases/download/v2.6.4/install.yaml
[ -f crds/argocd-app-crd.yaml ] || curl -fsSLo crds/argocd-app-crd.yaml https://raw.githubusercontent.com/argoproj/argo-cd/v2.14.11/manifests/crds/application-crd.yaml
[ -f crds/vpa-crd.yaml ] || curl -fsSLo crds/vpa-crd.yaml https://raw.githubusercontent.com/kubernetes/autoscaler/vpa-release-1.4/vertical-pod-autoscaler/deploy/vpa-v1-crd-gen.yaml
node extract-crds.mjs crds/flux-install.yaml crds/flux-crds.yaml

for name in dev prod; do
  kwokctl delete cluster --name "$name" >/dev/null 2>&1 || true
  kwokctl create cluster --name "$name" --runtime binary \
    --enable metrics-server \
    --enable-crds ClusterLogs,ClusterResourceUsage,ClusterExec,Metric \
    --wait 3m
  kubectl --context "kwok-$name" apply -f metrics-resource.yaml >/dev/null
done

./setup.sh kwok-dev gke a1b2c3d4
./setup.sh kwok-prod eks e5f6a7b8

# metrics-server needs a scrape cycle before resource metrics are served
for ctx in kwok-dev kwok-prod; do
  for _ in $(seq 1 60); do kubectl --context "$ctx" top pods -n kx-e2e-fixture >/dev/null 2>&1 && break; sleep 2; done
done
echo "clusters ready"
