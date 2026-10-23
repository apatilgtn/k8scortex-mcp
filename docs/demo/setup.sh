#!/usr/bin/env bash
# Puts the current kube context in the demo's starting state: checkout v1.4.2 healthy, then a
# v1.5.0 rollout that crash-loops because it cannot reach its database. Safe to re-run.
set -euo pipefail
NS=${DEMO_NAMESPACE:-shop}
K="kubectl -n $NS"

kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
$K delete deployment checkout --ignore-not-found --wait >/dev/null
cat <<EOF | $K apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: { name: checkout }
spec:
  replicas: 2
  selector: { matchLabels: { app: checkout } }
  template:
    metadata: { labels: { app: checkout } }
    spec:
      containers:
      - name: checkout
        image: busybox:1.36
        command: [sh, -c, 'echo "checkout v1.4.2 listening on :8080"; while true; do sleep 3600; done']
EOF
$K rollout status deployment/checkout --timeout=120s >/dev/null
$K patch deployment checkout --type=json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["sh","-c","echo \"checkout v1.5.0 starting\"; echo \"ERROR payments-db:5432 connection refused (DB_HOST=payments-db.shop.svc)\"; exit 1"]}]' >/dev/null
# Wait until the new pods are in CrashLoopBackOff
for _ in $(seq 1 60); do
  $K get pods -o jsonpath='{.items[*].status.containerStatuses[0].state.waiting.reason}' | grep -q CrashLoopBackOff && break
  sleep 2
done
$K get pods
