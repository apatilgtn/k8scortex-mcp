#!/usr/bin/env bash
# Seeds two clusters for docs/demo/walkthrough.mjs. Safe to re-run.
#   prod:    checkout v1.4.2, then a v1.5.0 rollout that crash-loops; payments-db secret;
#            Argo CD app "payments" two commits behind staging
#   staging: checkout healthy; Argo CD app "payments" at the newer revision
# Usage: setup-walkthrough.sh [staging-context] [prod-context]
set -euo pipefail
STAGING=${1:-kind-k8scortex-staging}
PROD=${2:-kind-k8scortex-prod}
F=$(cd "$(dirname "$0")" && pwd)
CRD=$F/../../tests/e2e/kwok/crds/argocd-app-crd.yaml
[ -f "$CRD" ] || { mkdir -p "$(dirname "$CRD")"; curl -fsSLo "$CRD" https://raw.githubusercontent.com/argoproj/argo-cd/v2.14.11/manifests/crds/application-crd.yaml; }

checkout() { # context command
  cat <<EOF
apiVersion: apps/v1
kind: Deployment
metadata: { name: checkout, namespace: shop }
spec:
  replicas: 2
  selector: { matchLabels: { app: checkout } }
  template:
    metadata: { labels: { app: checkout } }
    spec:
      containers:
      - name: checkout
        image: busybox:1.36
        command: [sh, -c, '$2']
EOF
}

app() { # revision
  cat <<EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: payments, namespace: argocd }
spec:
  project: default
  source: { repoURL: https://github.com/acme/payments-deploy.git, path: overlays/\$ENV, targetRevision: main }
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

# staging: healthy checkout, payments at the newer commit
checkout "$STAGING" 'echo "checkout v1.5.1 listening on :8080"; while true; do sleep 3600; done' | kubectl --context "$STAGING" apply -f - >/dev/null
kubectl --context "$STAGING" -n argocd patch application payments --type=merge -p '{"status":{"sync":{"status":"Synced","revision":"a71d4b8"},"health":{"status":"Healthy"}}}' >/dev/null

# prod: payments two commits behind, a database secret, and a bad checkout rollout
kubectl --context "$PROD" -n argocd patch application payments --type=merge -p '{"status":{"sync":{"status":"OutOfSync","revision":"9f3c2e1"},"health":{"status":"Healthy"}}}' >/dev/null
kubectl --context "$PROD" -n shop create secret generic payments-db --from-literal=password=initial-password --dry-run=client -o yaml | kubectl --context "$PROD" apply -f - >/dev/null
checkout "$PROD" 'echo "checkout v1.4.2 listening on :8080"; while true; do sleep 3600; done' | kubectl --context "$PROD" apply -f - >/dev/null
kubectl --context "$PROD" -n shop rollout status deployment/checkout --timeout=120s >/dev/null
kubectl --context "$PROD" -n shop patch deployment checkout --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["sh","-c","echo \"checkout v1.5.0 starting\"; echo \"ERROR payments-db:5432 connection refused (DB_HOST=payments-db.shop.svc)\"; exit 1"]}]' >/dev/null
kubectl --context "$STAGING" -n shop rollout status deployment/checkout --timeout=120s >/dev/null
for _ in $(seq 1 60); do
  kubectl --context "$PROD" -n shop get pods -o jsonpath='{.items[*].status.containerStatuses[0].state.waiting.reason}' | grep -q CrashLoopBackOff && break
  sleep 2
done
kubectl --context "$PROD" -n shop get pods
