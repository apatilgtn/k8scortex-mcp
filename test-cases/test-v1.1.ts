import { handleWorkloadCreationTool } from "./src/tools/workload_creation.js";
import { handleConfigManagementTool } from "./src/tools/config_management.js";
import { handleJobTool } from "./src/tools/jobs.js";

async function run() {
  process.env.DISABLE_AUTH = "true";
  console.log("========================================");
  console.log("🚀 Testing KubeNexus v1.1 Tools");
  console.log("========================================\n");

  const namespace = "mcp-test-ns-" + Math.floor(Math.random() * 1000);

  try {
    // --- WORKLOAD CREATION ---
    console.log(`[1] create_namespace: ${namespace}`);
    let res = await handleWorkloadCreationTool("create_namespace", { namespaceName: namespace, dryRun: false });
    console.log(res.content[0].text);

    console.log(`\n[2] create_deployment: nginx-test`);
    res = await handleWorkloadCreationTool("create_deployment", {
      namespace,
      deploymentName: "nginx-test",
      image: "nginx:alpine",
      replicas: 1,
      port: 80,
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[3] create_horizontal_pod_autoscaler: nginx-test-hpa`);
    res = await handleWorkloadCreationTool("create_horizontal_pod_autoscaler", {
      namespace,
      hpaName: "nginx-test-hpa",
      targetDeployment: "nginx-test",
      minReplicas: 1,
      maxReplicas: 3,
      targetCPUUtilizationPercentage: 80,
      dryRun: false
    });
    console.log(res.content[0].text);


    // --- CONFIG MANAGEMENT ---
    console.log(`\n[4] create_configmap: app-config`);
    res = await handleConfigManagementTool("create_configmap", {
      namespace,
      configMapName: "app-config",
      data: { "ENV": "test", "DEBUG": "true" },
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[5] update_configmap: app-config`);
    res = await handleConfigManagementTool("update_configmap", {
      namespace,
      configMapName: "app-config",
      data: { "DEBUG": "false" },
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[6] create_secret: app-secret`);
    res = await handleConfigManagementTool("create_secret", {
      namespace,
      secretName: "app-secret",
      stringData: { "API_KEY": "supersecret123" },
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[7] update_secret: app-secret`);
    res = await handleConfigManagementTool("update_secret", {
      namespace,
      secretName: "app-secret",
      stringData: { "API_KEY": "newsecret456" },
      dryRun: false
    });
    console.log(res.content[0].text);


    // --- JOB MANAGEMENT ---
    console.log(`\n[8] create_job: test-job`);
    res = await handleJobTool("create_job", {
      namespace,
      jobName: "test-job",
      image: "busybox",
      command: ["echo", "Hello from MCP!"],
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[9] list_jobs: test-job should be there`);
    res = await handleJobTool("list_jobs", { namespace });
    console.log(res.content[0].text);

    // CronJob tests require an existing cronjob to suspend/resume, we will create one via raw yaml string for testing
    console.log(`\n[10] create_job (CronJob via YAML)`);
    const cjYaml = `
apiVersion: batch/v1
kind: CronJob
metadata:
  name: test-cron
spec:
  schedule: "* * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: hello
            image: busybox
            command:
            - /bin/sh
            - -c
            - date; echo Hello
          restartPolicy: OnFailure
`;
    // We don't have create_cronjob, but create_job with raw YAML is just for Job.
    // Let's skip create cronjob and just delete the resources for now.
    
    // --- CLEANUP ---
    console.log(`\n[11] delete_deployment: nginx-test`);
    res = await handleWorkloadCreationTool("delete_deployment", {
      namespace,
      deploymentName: "nginx-test",
      dryRun: false
    });
    console.log(res.content[0].text);

    console.log(`\n[12] delete_namespace: ${namespace}`);
    res = await handleWorkloadCreationTool("delete_namespace", {
      namespaceName: namespace,
      dryRun: false
    });
    console.log(res.content[0].text);

  } catch (e: any) {
    console.error("Test failed:", e);
  }
}

run();
