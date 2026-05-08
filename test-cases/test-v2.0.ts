import { handleGitOpsTool } from "./src/tools/gitops.js";

async function run() {
  process.env.DISABLE_AUTH = "true";
  console.log("========================================");
  console.log("🚀 Testing KubeNexus v2.0 GitOps Tools");
  console.log("========================================\n");

  const namespace = "argocd";
  const appName = "test-app";

  try {
    console.log(`\n[1] get_gitops_app_status (ArgoCD)`);
    let res = await handleGitOpsTool("get_gitops_app_status", {
      engine: "argocd",
      namespace,
      appName
    });
    console.log(res.content[0].text);

    console.log(`\n[2] get_gitops_diff (ArgoCD)`);
    res = await handleGitOpsTool("get_gitops_diff", {
      engine: "argocd",
      namespace,
      appName
    });
    console.log(res.content[0].text);

    console.log(`\n[3] sync_gitops_app (ArgoCD) (DRY RUN)`);
    res = await handleGitOpsTool("sync_gitops_app", {
      engine: "argocd",
      namespace,
      appName,
      dryRun: true
    });
    console.log(res.content[0].text);
    
    console.log(`\n[4] compare_clusters (ArgoCD)`);
    res = await handleGitOpsTool("compare_clusters", {
      engine: "argocd",
      namespace,
      appName,
      clusterA: "default",
      clusterB: "default"
    });
    console.log(res.content[0].text);

  } catch (e: any) {
    console.error("Test failed:", e);
  }
}

run();
