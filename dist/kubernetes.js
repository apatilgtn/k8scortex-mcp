import { getK8sClientForCluster } from "./cluster-store.js";
// Re-export for backwards compatibility in local tests
export function getK8sClient() {
    const kc = require("@kubernetes/client-node");
    const client = new kc.KubeConfig();
    client.loadFromDefault();
    return {
        coreV1Api: client.makeApiClient(kc.CoreV1Api),
        appsV1Api: client.makeApiClient(kc.AppsV1Api),
        autoscalingV2Api: client.makeApiClient(kc.AutoscalingV2Api),
    };
}
export { getK8sClientForCluster };
