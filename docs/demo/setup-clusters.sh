#!/usr/bin/env bash
# Seeds a staging and a prod cluster for docs/demo/claude/record.mjs. Safe to re-run.
#   prod:    checkout 1.4.2, then a rollout of 1.5.0 that cannot reach its database and crash-loops;
#            payments-db secret; Argo CD app "payments" behind staging
#   staging: checkout 1.5.1 (fixed); Argo CD app "payments" at the newer revision
# The acme/checkout images are built from docs/demo/checkout and loaded into kind clusters.
# Usage: setup-clusters.sh [staging-context] [prod-context]
set -euo pipefail
STAGING=${1:-kind-k8scortex-staging}
PROD=${2:-kind-k8scortex-prod}
F=$(cd "$(dirname "$0")" && pwd)
CRD=$F/../../tests/e2e/kwok/crds/argocd-app-crd.yaml
[ -f "$CRD" ] || { mkdir -p "$(dirname "$CRD")"; curl -fsSLo "$CRD" https://raw.githubusercontent.com/argoproj/argo-cd/v2.14.11/manifests/crds/application-crd.yaml; }

# Images: 1.4.2 and 1.5.1 work, 1.5.0 fails to reach its database
for v in 1.4.2 1.5.0 1.5.1; do
  fail=false; [ "$v" = 1.5.0 ] && fail=true
  docker build -q -t "acme/checkout:$v" --build-arg VERSION="$v" --build-arg FAIL="$fail" "$F/checkout" >/dev/null
  for ctx in "$STAGING" "$PROD"; do
    case $ctx in kind-*) kind load docker-image "acme/checkout:$v" --name "${ctx#kind-}" >/dev/null 2>&1 ;; esac
  done
done

checkout() { # version
  cat <<EOF
apiVersion: apps/v1
kind: Deployment
metadata: { name: checkout, namespace: shop, labels: { app: checkout } }
spec:
  replicas: 2
  selector: { matchLabels: { app: checkout } }
  template:
    metadata: { labels: { app: checkout } }
    spec:
      containers:
      - name: checkout
        image: acme/checkout:$1
        imagePullPolicy: IfNotPresent
        ports: [{ containerPort: 8080 }]
EOF
}

app() {
  cat <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: payments, namespace: argocd }
spec:
  project: default
  source: { repoURL: https://github.com/acme/payments-deploy.git, path: overlays/main, targetRevision: main }
  destination: { server: https://kubernetes.default.svc, namespace: shop }
EOF
}

for ctx in "$STAGING" "$PROD"; do
  K="kubectl --context $ctx"
  $K apply -f "$CRD" --server-side >/dev/null
  for _ in $(seq 1 30); do
    [ "$($K get crd applications.argoproj.io -o jsonpath='{.status.conditions[?(@.type=="Established")].status}' 2>/dev/null)" = True ] && break
    sleep 1
  done
  for ns in shop argocd; do $K create namespace $ns --dry-run=client -o yaml | $K apply -f - >/dev/null; done
  $K -n shop delete deployment checkout --ignore-not-found --wait >/dev/null
  $K -n argocd delete application payments --ignore-not-found >/dev/null
  app | $K apply -f - >/dev/null
done

# staging: fixed checkout, payments at the newer commit
checkout 1.5.1 | kubectl --context "$STAGING" apply -f - >/dev/null
kubectl --context "$STAGING" -n argocd patch application payments --type=merge -p '{"status":{"sync":{"status":"Synced","revision":"a71d4b8"},"health":{"status":"Healthy"}}}' >/dev/null

# prod: payments behind, a database secret, and the bad 1.5.0 rollout on top of a healthy 1.4.2
kubectl --context "$PROD" -n argocd patch application payments --type=merge -p '{"status":{"sync":{"status":"OutOfSync","revision":"9f3c2e1"},"health":{"status":"Healthy"}}}' >/dev/null
kubectl --context "$PROD" -n shop create secret generic payments-db --from-literal=username=checkout --from-literal=password=initial-password --dry-run=client -o yaml | kubectl --context "$PROD" apply -f - >/dev/null
checkout 1.4.2 | kubectl --context "$PROD" apply -f - >/dev/null
kubectl --context "$PROD" -n shop rollout status deployment/checkout --timeout=120s >/dev/null
kubectl --context "$PROD" -n shop set image deployment/checkout checkout=acme/checkout:1.5.0 >/dev/null
kubectl --context "$STAGING" -n shop rollout status deployment/checkout --timeout=120s >/dev/null
for _ in $(seq 1 60); do
  kubectl --context "$PROD" -n shop get pods -o jsonpath='{.items[*].status.containerStatuses[0].state.waiting.reason}' | grep -q CrashLoopBackOff && break
  sleep 2
done
kubectl --context "$PROD" -n shop get pods
