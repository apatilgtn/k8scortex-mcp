#!/usr/bin/env bash
# Seeds a KWOK cluster with fixtures for the K8sCortex tool matrix.
# Usage: setup.sh <context> <gke|eks> <argo-revision>
set -euo pipefail
CTX=$1; FLAVOR=$2; REV=$3
F=$(cd "$(dirname "$0")" && pwd)
K="kubectl --context $CTX"
NS=kx-e2e-fixture

if [ "$FLAVOR" = gke ]; then
  POOL_LABEL=cloud.google.com/gke-nodepool; POOL_A=default-pool; POOL_B=spot-pool
  SPOT_LABEL='cloud.google.com/gke-spot: "true"'; ZONE_A=us-central1-a; ZONE_B=us-central1-b
  ITYPE=e2-standard-4; PROVIDER_A="gce://demo-proj/us-central1-a"; PROVIDER_B="gce://demo-proj/us-central1-b"
  NODE_PREFIX=gke-dev; CNI=gke-node-config; SC_PROVISIONER=pd.csi.storage.gke.io
  WI_ANNOTATION='iam.gke.io/gcp-service-account: app@demo-proj.iam.gserviceaccount.com'
else
  POOL_LABEL=eks.amazonaws.com/nodegroup; POOL_A=ng-general; POOL_B=ng-spot
  SPOT_LABEL='eks.amazonaws.com/capacityType: SPOT'; ZONE_A=us-east-1a; ZONE_B=us-east-1b
  ITYPE=m6i.xlarge; PROVIDER_A="aws:///us-east-1a"; PROVIDER_B="aws:///us-east-1b"
  NODE_PREFIX=ip-10-0; CNI=aws-node; SC_PROVISIONER=ebs.csi.aws.com
  WI_ANNOTATION='eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/app'
fi

node() { # name pool zone providerID extraLabel
  cat <<EOF
apiVersion: v1
kind: Node
metadata:
  name: $1
  annotations: { kwok.x-k8s.io/node: fake, node.alpha.kubernetes.io/ttl: "0", metrics.k8s.io/resource-metrics-path: "/metrics/nodes/$1/metrics/resource" }
  labels:
    kubernetes.io/arch: amd64
    kubernetes.io/os: linux
    kubernetes.io/hostname: $1
    type: kwok
    $POOL_LABEL: $2
    topology.kubernetes.io/zone: $3
    node.kubernetes.io/instance-type: $ITYPE
    ${5:-kx/extra: "none"}
spec:
  providerID: $4/$1
status:
  allocatable: { cpu: "4", memory: 16Gi, pods: "110" }
  capacity: { cpu: "4", memory: 16Gi, pods: "110" }
  nodeInfo: { architecture: amd64, kubeletVersion: fake, kubeProxyVersion: fake, operatingSystem: linux, osImage: "Container-Optimized OS", containerRuntimeVersion: "containerd://1.7", kernelVersion: "6.1.0-kwok", bootID: "", machineID: "", systemUUID: "" }
  phase: Running
---
EOF
}

{
  node ${NODE_PREFIX}-a-1 $POOL_A $ZONE_A $PROVIDER_A
  node ${NODE_PREFIX}-a-2 $POOL_A $ZONE_B $PROVIDER_B
  node ${NODE_PREFIX}-b-1 $POOL_B $ZONE_A $PROVIDER_A "$SPOT_LABEL"
  # Dedicated node for real (non dry-run) cordon/drain/taint
  node ${NODE_PREFIX}-drain-1 $POOL_B $ZONE_B $PROVIDER_B "$SPOT_LABEL"
} | $K apply -f - >/dev/null

$K apply -f $F/crds/flux-crds.yaml --server-side >/dev/null
$K apply -f $F/crds/argocd-app-crd.yaml --server-side >/dev/null
$K apply -f $F/crds/vpa-crd.yaml --server-side >/dev/null
$K wait --for=condition=Established crd --all --timeout=60s >/dev/null

cat <<EOF | $K apply -f - >/dev/null
apiVersion: v1
kind: Namespace
metadata: { name: $NS }
---
apiVersion: v1
kind: Namespace
metadata: { name: argocd }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: coredns, namespace: kube-system, labels: { k8s-app: kube-dns } }
spec:
  replicas: 2
  selector: { matchLabels: { k8s-app: kube-dns } }
  template:
    metadata: { labels: { k8s-app: kube-dns } }
    spec: { containers: [{ name: coredns, image: registry.k8s.io/coredns/coredns:v1.12.0 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: metrics-server, namespace: kube-system, labels: { k8s-app: metrics-server } }
spec:
  replicas: 1
  selector: { matchLabels: { k8s-app: metrics-server } }
  template:
    metadata: { labels: { k8s-app: metrics-server } }
    spec: { containers: [{ name: metrics-server, image: registry.k8s.io/metrics-server/metrics-server:v0.7.2 }] }
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: kube-proxy, namespace: kube-system }
spec:
  selector: { matchLabels: { k8s-app: kube-proxy } }
  template:
    metadata: { labels: { k8s-app: kube-proxy } }
    spec: { tolerations: [{ operator: Exists }], containers: [{ name: kube-proxy, image: registry.k8s.io/kube-proxy:v1.33.0 }] }
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: $CNI, namespace: kube-system }
spec:
  selector: { matchLabels: { k8s-app: $CNI } }
  template:
    metadata: { labels: { k8s-app: $CNI } }
    spec: { tolerations: [{ operator: Exists }], containers: [{ name: cni, image: example/cni:1.0 }] }
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: standard-rwo, annotations: { storageclass.kubernetes.io/is-default-class: "true" } }
provisioner: $SC_PROVISIONER
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters: { type: balanced }
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
        resources: { requests: { cpu: 100m, memory: 64Mi }, limits: { cpu: 200m, memory: 128Mi } }
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
    spec: { containers: [{ name: db, image: postgres:16 }] }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: wi-sa, namespace: $NS, annotations: { $WI_ANNOTATION } }
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
spec: { hard: { pods: "20", requests.cpu: "4", requests.memory: 8Gi } }
---
apiVersion: v1
kind: LimitRange
metadata: { name: fixture-limits, namespace: $NS }
spec:
  limits:
  - type: Container
    default: { cpu: 500m, memory: 256Mi }
    defaultRequest: { cpu: 100m, memory: 64Mi }
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
    spec: { template: { spec: { restartPolicy: OnFailure, containers: [{ name: c, image: busybox, command: [echo, hi] }] } } }
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
status:
  sync: { status: Synced, revision: $REV }
  health: { status: Healthy }
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
---
apiVersion: kwok.x-k8s.io/v1alpha1
kind: ClusterLogs
metadata: { name: fixture-logs }
spec:
  selector: { matchNamespaces: [$NS] }
  logs: [{ containers: [], logsFile: $F/fixture.log, follow: false }]
---
apiVersion: kwok.x-k8s.io/v1alpha1
kind: ClusterResourceUsage
metadata: { name: fixture-usage }
spec:
  usages: [{ usage: { cpu: { value: 80m }, memory: { value: 48Mi } } }]
EOF

# Status for objects whose controllers do not run in KWOK
$K -n $NS patch vpa fixture-vpa --subresource=status --type=merge -p '{"status":{"recommendation":{"containerRecommendations":[{"containerName":"fixture-deploy","target":{"cpu":"150m","memory":"96Mi"},"lowerBound":{"cpu":"100m","memory":"64Mi"},"upperBound":{"cpu":"300m","memory":"192Mi"}}]}}}' >/dev/null
$K -n $NS patch kustomization fixture-kustomization --subresource=status --type=merge -p "{\"status\":{\"lastAppliedRevision\":\"main@sha1:$REV\",\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\",\"reason\":\"ReconciliationSucceeded\",\"message\":\"Applied revision\",\"lastTransitionTime\":\"2026-10-22T00:00:00Z\"}]}}" >/dev/null
$K -n $NS patch helmrelease fixture-helmrelease --subresource=status --type=merge -p '{"status":{"lastAttemptedRevision":"6.7.0","history":[{"chartName":"podinfo","chartVersion":"6.7.0","name":"fixture-helmrelease","namespace":"kx-e2e-fixture","status":"deployed","version":1,"digest":"sha256:0000","firstDeployed":"2026-10-22T00:00:00Z","lastDeployed":"2026-10-22T00:00:00Z","configDigest":"sha256:0000"}],"conditions":[{"type":"Ready","status":"True","reason":"InstallSucceeded","message":"Helm install succeeded","lastTransitionTime":"2026-10-22T00:00:00Z"}]}}' >/dev/null

# Second rollout so rollout_undo has a revision to go back to
$K -n $NS set image deployment/fixture-deploy fixture-deploy=nginx:1.28-alpine >/dev/null
$K -n $NS rollout status deployment/fixture-deploy --timeout=60s >/dev/null
# A pod on the drain node so drain has something to evict
cat <<EOF | $K apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: drain-victim, namespace: $NS }
spec: { nodeName: ${NODE_PREFIX}-drain-1, containers: [{ name: c, image: busybox }] }
EOF
echo "seeded $CTX ($FLAVOR)"
