#!/usr/bin/env bash
# Seeds a real GKE cluster with fixtures for the K8sCortex GKE matrix.
# Usage: setup.sh <context>
# Unlike the KWOK fixtures, nodes, kube-system addons, logs and metrics are the real ones.
set -euo pipefail
CTX=$1
F=$(cd "$(dirname "$0")" && pwd)
CRDS=$F/../kwok/crds
K="kubectl --context $CTX"
NS=kx-gke-e2e

# Same CRDs as the KWOK matrix (no controllers run, so statuses are patched below)
mkdir -p "$CRDS"
[ -f "$CRDS/flux-install.yaml" ] || curl -fsSLo "$CRDS/flux-install.yaml" https://github.com/fluxcd/flux2/releases/download/v2.6.4/install.yaml
[ -f "$CRDS/argocd-app-crd.yaml" ] || curl -fsSLo "$CRDS/argocd-app-crd.yaml" https://raw.githubusercontent.com/argoproj/argo-cd/v2.14.11/manifests/crds/application-crd.yaml
[ -f "$CRDS/vpa-crd.yaml" ] || curl -fsSLo "$CRDS/vpa-crd.yaml" https://raw.githubusercontent.com/kubernetes/autoscaler/vpa-release-1.4/vertical-pod-autoscaler/deploy/vpa-v1-crd-gen.yaml
[ -f "$CRDS/flux-crds.yaml" ] || node "$F/../kwok/extract-crds.mjs" "$CRDS/flux-install.yaml" "$CRDS/flux-crds.yaml"

$K apply -f "$CRDS/flux-crds.yaml" --server-side >/dev/null
$K apply -f "$CRDS/argocd-app-crd.yaml" --server-side >/dev/null
# GKE ships its own VPA CRD when vertical Pod autoscaling is enabled
$K get crd verticalpodautoscalers.autoscaling.k8s.io >/dev/null 2>&1 || $K apply -f "$CRDS/vpa-crd.yaml" --server-side >/dev/null
$K wait --for=condition=Established crd --all --timeout=60s >/dev/null

# GKE expires events after an hour, so recreate the fixture event rather than leave a nearly expired one
$K -n $NS delete event fixture-warning --ignore-not-found >/dev/null 2>&1 || true

# Requests are kept small so everything fits on one e2-standard-2 node
cat <<EOF | $K apply -f - >/dev/null
apiVersion: v1
kind: Namespace
metadata: { name: $NS }
---
apiVersion: v1
kind: Namespace
metadata: { name: argocd }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: wi-sa, namespace: $NS, annotations: { iam.gke.io/gcp-service-account: app@demo-proj.iam.gserviceaccount.com } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: fixture-deploy, namespace: $NS, labels: { app: fixture-deploy } }
spec:
  replicas: 2
  revisionHistoryLimit: 5
  selector: { matchLabels: { app: fixture-deploy } }
  template:
    metadata: { labels: { app: fixture-deploy } }
    spec:
      serviceAccountName: wi-sa
      containers:
      - name: fixture-deploy
        image: nginx:1.27-alpine
        ports: [{ containerPort: 80 }]
        resources: { requests: { cpu: 20m, memory: 32Mi }, limits: { cpu: 100m, memory: 64Mi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: fixture-logger, namespace: $NS, labels: { app: fixture-logger } }
spec:
  replicas: 1
  selector: { matchLabels: { app: fixture-logger } }
  template:
    metadata: { labels: { app: fixture-logger } }
    spec:
      containers:
      - name: logger
        image: busybox:1.36
        command: [sh, -c, 'echo "fixture app started"; i=0; while true; do i=\$((i+1)); echo "slow upstream response \$i"; sleep 5; done']
        resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 50m, memory: 32Mi } }
---
apiVersion: v1
kind: Service
metadata: { name: fixture-sts, namespace: $NS }
spec: { clusterIP: None, selector: { app: fixture-sts }, ports: [{ port: 80 }] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: fixture-sts, namespace: $NS }
spec:
  serviceName: fixture-sts
  replicas: 1
  selector: { matchLabels: { app: fixture-sts } }
  template:
    metadata: { labels: { app: fixture-sts } }
    spec:
      containers:
      - name: db
        image: busybox:1.36
        command: [sh, -c, "sleep infinity"]
        resources: { requests: { cpu: 10m, memory: 16Mi }, limits: { cpu: 50m, memory: 32Mi } }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: fixture-config, namespace: $NS }
data: { LOG_LEVEL: info, FEATURE_X: "true" }
---
apiVersion: v1
kind: Secret
metadata: { name: fixture-secret, namespace: $NS }
stringData: { password: do-not-leak }
---
apiVersion: v1
kind: ResourceQuota
metadata: { name: fixture-quota, namespace: $NS }
spec: { hard: { pods: "20", requests.cpu: "2", requests.memory: 2Gi } }
---
apiVersion: v1
kind: LimitRange
metadata: { name: fixture-limits, namespace: $NS }
spec:
  limits:
  - type: Container
    default: { cpu: 500m, memory: 256Mi }
    defaultRequest: { cpu: 10m, memory: 16Mi }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: fixture-pvc, namespace: $NS }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } }, storageClassName: standard-rwo }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: fixture-deploy, namespace: $NS }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: fixture-deploy }
  minReplicas: 2
  maxReplicas: 5
  metrics: [{ type: Resource, resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } } }]
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: fixture-cron, namespace: $NS }
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec: { template: { spec: { restartPolicy: OnFailure, containers: [{ name: c, image: busybox:1.36, command: [echo, hi] }] } } }
---
apiVersion: v1
kind: Service
metadata: { name: fixture-deploy, namespace: $NS }
spec: { selector: { app: fixture-deploy }, ports: [{ port: 80, targetPort: 80 }] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: fixture-ingress, namespace: $NS }
spec:
  rules:
  - host: fixture.example.com
    http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: fixture-deploy, port: { number: 80 } } } }] }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: fixture-pdb, namespace: $NS }
spec: { minAvailable: 1, selector: { matchLabels: { app: fixture-deploy } } }
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: { name: fixture-vpa, namespace: $NS }
spec:
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: fixture-deploy }
  updatePolicy: { updateMode: "Off" }
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: test-app, namespace: argocd }
spec:
  project: default
  source: { repoURL: https://github.com/example/apps.git, path: test-app, targetRevision: main }
  destination: { server: https://kubernetes.default.svc, namespace: $NS }
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata: { name: fixture-repo, namespace: $NS }
spec: { interval: 5m, url: https://github.com/example/apps.git, ref: { branch: main } }
---
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata: { name: fixture-charts, namespace: $NS }
spec: { interval: 1h, url: https://charts.example.com }
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata: { name: fixture-kustomization, namespace: $NS }
spec: { interval: 10m, path: ./apps, prune: true, sourceRef: { kind: GitRepository, name: fixture-repo } }
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata: { name: fixture-helmrelease, namespace: $NS }
spec:
  interval: 10m
  chart: { spec: { chart: podinfo, version: "6.x", sourceRef: { kind: HelmRepository, name: fixture-charts } } }
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata: { name: fixture-slack, namespace: $NS }
spec: { type: slack, channel: alerts }
---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata: { name: fixture-alert, namespace: $NS }
spec:
  providerRef: { name: fixture-slack }
  eventSeverity: error
  eventSources: [{ kind: Kustomization, name: "*" }]
---
apiVersion: v1
kind: Event
metadata: { name: fixture-warning, namespace: $NS }
involvedObject: { kind: Deployment, name: fixture-deploy, namespace: $NS }
reason: BackOff
message: "Back-off restarting failed container (fixture)"
type: Warning
count: 3
EOF

# Status for objects whose controllers do not run here
$K -n argocd patch application test-app --type=merge -p '{"status":{"sync":{"status":"Synced","revision":"a1b2c3d4"},"health":{"status":"Healthy"}}}' >/dev/null
$K -n $NS patch vpa fixture-vpa --subresource=status --type=merge -p '{"status":{"recommendation":{"containerRecommendations":[{"containerName":"fixture-deploy","target":{"cpu":"150m","memory":"96Mi"},"lowerBound":{"cpu":"100m","memory":"64Mi"},"upperBound":{"cpu":"300m","memory":"192Mi"}}]}}}' >/dev/null
$K -n $NS patch kustomization fixture-kustomization --subresource=status --type=merge -p '{"status":{"lastAppliedRevision":"main@sha1:a1b2c3d4","conditions":[{"type":"Ready","status":"True","reason":"ReconciliationSucceeded","message":"Applied revision","lastTransitionTime":"2026-10-22T00:00:00Z"}]}}' >/dev/null
$K -n $NS patch helmrelease fixture-helmrelease --subresource=status --type=merge -p "{\"status\":{\"lastAttemptedRevision\":\"6.7.0\",\"history\":[{\"chartName\":\"podinfo\",\"chartVersion\":\"6.7.0\",\"name\":\"fixture-helmrelease\",\"namespace\":\"$NS\",\"status\":\"deployed\",\"version\":1,\"digest\":\"sha256:0000\",\"firstDeployed\":\"2026-10-22T00:00:00Z\",\"lastDeployed\":\"2026-10-22T00:00:00Z\",\"configDigest\":\"sha256:0000\"}],\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\",\"reason\":\"InstallSucceeded\",\"message\":\"Helm install succeeded\",\"lastTransitionTime\":\"2026-10-22T00:00:00Z\"}]}}" >/dev/null

# Second rollout so rollout_undo has a revision to go back to
$K -n $NS rollout status deployment/fixture-deploy --timeout=180s >/dev/null
$K -n $NS set image deployment/fixture-deploy fixture-deploy=nginx:1.28-alpine >/dev/null
$K -n $NS rollout status deployment/fixture-deploy --timeout=180s >/dev/null
$K -n $NS rollout status deployment/fixture-logger --timeout=180s >/dev/null
$K -n $NS rollout status statefulset/fixture-sts --timeout=180s >/dev/null

# metrics-server needs a scrape cycle before the new pods have metrics
for _ in $(seq 1 60); do $K top pods -n $NS 2>/dev/null | grep -q fixture-deploy && break; sleep 3; done
echo "seeded $CTX"
