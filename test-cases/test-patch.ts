import * as k8s from "@kubernetes/client-node";
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const core = kc.makeApiClient(k8s.CoreV1Api);

async function run() {
  try {
    await core.patchNamespacedConfigMap({
      name: "kube-root-ca.crt",
      namespace: "default",
      body: { data: { test: "value" } }
    }, { headers: { "Content-Type": "application/merge-patch+json" } } as any);
    console.log("Success with headers!");
  } catch (e: any) {
    console.log("Error headers:", e.body?.message || e.message);
  }
}
run();
