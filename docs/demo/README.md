# README demo

`demo.gif` is a recording of [`demo.mjs`](demo.mjs): two users talk to a real K8sCortex server over
Streamable HTTP, and every line of output is a real tool result from a kind cluster. There is no LLM in
the recording; the questions are typed by the script to show the calls an agent would make.

- **priya** (`developer`) finds why `checkout` is crash-looping, then is denied a rollback
- **sam** (`release-manager`) gets a dry run, rolls back for real and checks the rollout
- the audit records the server wrote to stdout for those calls

The users sign in with tokens signed by `TEST_JWT_SECRET`, a test-only alternative to OIDC.

## Re-record

```bash
kind create cluster --name k8scortex-demo
npm run build
docs/demo/setup.sh                          # checkout v1.4.2, then a crash-looping v1.5.0
node docs/demo/demo.mjs                     # run it in your terminal, or record it:

kind get kubeconfig --internal --name k8scortex-demo > /tmp/kind-internal
docker build -t k8scortex-vhs docs/demo
docs/demo/setup.sh
docker run --rm --network kind -v "$PWD:/repo" -v /tmp/kind-internal:/kube/config:ro \
  -e KUBECONFIG=/kube/config -w /repo k8scortex-vhs docs/demo/demo.tape
```
