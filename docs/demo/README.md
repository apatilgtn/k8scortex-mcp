# Demos

Both recordings replay real MCP tool calls: users talk to a real K8sCortex server over Streamable HTTP,
and every line of output is a real result from kind clusters. There is no LLM in the recordings; the
scripts type the questions to show the calls an agent would make. Users sign in with tokens signed by
`TEST_JWT_SECRET`, a test-only alternative to OIDC.

| Recording | Script | What it shows |
|---|---|---|
| [`demo.gif`](demo.gif) (20 s) | [`demo.mjs`](demo.mjs) | A developer diagnoses a crash-looping deployment and is denied a rollback; a release manager dry-runs and rolls back |
| [`walkthrough.gif`](walkthrough.gif) (70 s) | [`walkthrough.mjs`](walkthrough.mjs) | Five business scenarios across a `staging` and a `prod` cluster with production policies |

## The walkthrough

The registry gives prod two policies: any change needs `sre`, and `drain_node` / `delete_namespace` are disabled.

1. **Checkout is down in prod.** Priya (developer) finds `CrashLoopBackOff` and the database error in the logs. Her rollback is denied by role, Sam's (release-manager) by the prod policy; Maria (SRE) dry-runs, rolls back and confirms 2/2 available.
2. **Is prod running what we tested?** `compare_clusters` finds the Argo CD app `payments` on different revisions. Sam syncs staging; syncing prod is denied.
3. **Flash sale.** Maria dry-runs and then scales checkout in prod to 6 replicas.
4. **Rotate a database password.** Priya cannot read Secrets through generic reads; Maria rotates `payments-db`, the value is not echoed back and is `[REDACTED]` in the audit record.
5. **Node maintenance.** Alex (platform-engineer) cannot drain a prod node at all; on staging the drain is a dry run.

It ends with the audit trail: every call, who made it, on which cluster, and whether it succeeded, failed or was denied.

## Run or re-record

```bash
npm run build
docker build -t k8scortex-vhs docs/demo          # VHS with Node.js

# Short demo: one cluster
kind create cluster --name k8scortex-demo
docs/demo/setup.sh && node docs/demo/demo.mjs

# Walkthrough: two clusters
kind create cluster --name k8scortex-staging
kind create cluster --name k8scortex-prod
docs/demo/setup-walkthrough.sh && node docs/demo/walkthrough.mjs
```

To record, run VHS on the `kind` Docker network with a kubeconfig that uses the clusters' internal addresses
(`kind get kubeconfig --internal --name <cluster>`; merge both for the walkthrough), then re-run the setup
script before each take:

```bash
docker run --rm --network kind -v "$PWD:/repo" -v /tmp/kind-internal:/kube/config:ro \
  -e KUBECONFIG=/kube/config -w /repo k8scortex-vhs docs/demo/demo.tape          # writes demo.gif
docker run --rm --network kind -v "$PWD:/repo" -v /tmp/kind-internal:/kube/config:ro \
  -e KUBECONFIG=/kube/config -w /repo k8scortex-vhs docs/demo/walkthrough.tape   # writes walkthrough.mp4
```

The walkthrough is recorded to MP4 because VHS's own GIF encoding runs out of memory at this length.
Convert it at real speed (VHS captures it about twice as fast as real time when the machine is busy;
compare the MP4's duration with the script's run time) and compress it:

```bash
ffmpeg -i docs/demo/walkthrough.mp4 -vf "setpts=2.0*PTS,fps=6,palettegen=max_colors=64:stats_mode=full" /tmp/pal.png
ffmpeg -i docs/demo/walkthrough.mp4 -i /tmp/pal.png \
  -lavfi "setpts=2.0*PTS,fps=6[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" docs/demo/walkthrough.gif
gifsicle -O3 --lossy=20 docs/demo/walkthrough.gif -o docs/demo/walkthrough.gif
```
