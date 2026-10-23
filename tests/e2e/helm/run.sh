#!/usr/bin/env bash
# Installs the Helm chart on the current kube context and runs the smoke test twice:
# with read-only RBAC (the default) and with rbac.allowWrites=true.
# Usage: tests/e2e/helm/run.sh [image-repository] [image-tag]
set -euo pipefail
cd "$(dirname "$0")/../../.."

REPO=${1:-ghcr.io/apatilgtn/k8scortex-mcp}
TAG=${2:-}
NS=k8scortex-smoke
SECRET=helm-smoke-$RANDOM$RANDOM
PORT=${PORT:-3077}

install() {
  helm upgrade --install smoke charts/k8scortex -n "$NS" --create-namespace --wait --timeout 3m \
    --set image.repository="$REPO" ${TAG:+--set image.tag="$TAG"} \
    --set auth.oidc.issuer=https://idp.invalid --set auth.oidc.audience=k8scortex \
    --set "extraEnv[0].name=TEST_JWT_SECRET" --set "extraEnv[0].value=$SECRET" \
    --set rbac.allowWrites="$1" >/dev/null
}

smoke() {
  kubectl -n "$NS" port-forward svc/smoke-k8scortex "$PORT:80" >/dev/null 2>&1 &
  local pf=$!
  for _ in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  MCP_URL="http://localhost:$PORT/mcp" TEST_JWT_SECRET="$SECRET" EXPECT_WRITES="$1" npx tsx tests/e2e/helm/smoke.ts || { kill $pf; return 1; }
  kill $pf
}

trap 'helm uninstall smoke -n "$NS" >/dev/null 2>&1 || true; kubectl delete namespace "$NS" --wait=false >/dev/null 2>&1 || true' EXIT

echo "── read-only RBAC"
install false && smoke false
echo "── rbac.allowWrites=true"
install true && kubectl -n "$NS" rollout status deploy/smoke-k8scortex >/dev/null && smoke true
