# Claude Code + K8sCortex demo

Real Claude Code sessions operating two kind clusters, `staging` and `prod`, through K8sCortex.

| | |
|---|---|
| [`claude/incident.gif`](claude/incident.gif) | Scene 1 (40 s): a prod incident, from diagnosis to an SRE's rollback |
| [`claude/claude-demo.mp4`](claude/claude-demo.mp4) | All five scenes (97 s) |
| [`claude/claude.cast`](claude/claude.cast) | All five scenes as an [asciinema](https://asciinema.org) recording with a chapter per scene |
| [`claude/session.json`](claude/session.json) | The recorded sessions: prompts, every tool call and result, Claude's answers, and the server's audit records |

## What was recorded

Each person is a separate `claude -p` session. K8sCortex is the only tool source (`--strict-mcp-config`), all
built-in tools are off (`--tools ""`), and each session signs in to K8sCortex with that person's token, so the
server's roles and policies apply to Claude exactly as they would to that person. Prod has two policies: any
change needs `sre`, and `drain_node` / `delete_namespace` are disabled.

| Person | Role |
|---|---|
| priya | developer |
| sam | release-manager |
| maria | sre |
| alex | platform-engineer |

1. **Checkout is down in prod.** Priya asks what's wrong. Claude reads the crash-looping 1.5.0 pod's logs, finds the database connection error, tries to roll back and is denied: rollbacks need release-manager. Sam's rollback is denied by the prod policy. Maria previews the rollback, then has Claude apply it and confirm 2/2 healthy on 1.4.2.
2. **Is prod running what we tested?** Claude compares Argo CD's `payments` across clusters and finds prod behind. Sam's staging sync works; his prod sync is denied, and when he insists Claude explains it is a permission rule, not a confirmation.
3. **Flash sale.** Maria asks for 6 replicas with a dry run first; Claude dry-runs, applies and confirms 6/6.
4. **Password rotation.** Priya cannot list Secrets. Maria has Claude rotate `payments-db`'s password without showing it: dry run, then apply after she confirms. The audit record has the value `[REDACTED]`.
5. **Node maintenance.** Claude warns Alex that prod has a single node; when he confirms, the drain is blocked by policy. The staging rehearsal is a dry run.

The replay ends with the audit trail K8sCortex wrote during the sessions.

**Edited for the recording:** a system prompt asks Claude to keep replies to a few short lines. The replay skips
Claude Code's internal `ToolSearch` calls and shows each tool result as a one-line preview. The new password
Claude generated is masked (`••••••••`) in `session.json`. Nothing else is changed; the clusters were throwaway kind
clusters.

## Re-record

```bash
npm run build
kind create cluster --name k8scortex-staging
kind create cluster --name k8scortex-prod
docs/demo/setup-clusters.sh                    # builds acme/checkout 1.4.2 / 1.5.0 / 1.5.1, seeds both clusters
node docs/demo/claude/record.mjs               # runs the Claude sessions, writes claude/session.json
```

Claude's answers differ between runs, so review `session.json` before replacing the recordings.

## Render

`replay.mjs` replays `session.json` in a terminal, or writes an asciicast with exact timing:

```bash
node docs/demo/claude/replay.mjs                                         # watch it
CAST=docs/demo/claude/claude.cast node docs/demo/claude/replay.mjs
SCENES=1 CAST=docs/demo/claude/incident.cast node docs/demo/claude/replay.mjs
```

GIFs are rendered with [agg](https://github.com/asciinema/agg) (needs glibc 2.38+, e.g. Ubuntu 24.04, and the
JetBrains Mono font), and the MP4 from the full GIF with ffmpeg:

```bash
THEME=1e1e2e,cdd6f4,45475a,f38ba8,a6e3a1,f9e2af,89b4fa,f5c2e7,94e2d5,bac2de,585b70,f38ba8,a6e3a1,f9e2af,89b4fa,f5c2e7,94e2d5,a6adc8
agg --font-family "JetBrains Mono" --font-size 14 --theme $THEME --fps-cap 12 --last-frame-duration 4 \
  docs/demo/claude/incident.cast docs/demo/claude/incident.gif
agg --font-family "JetBrains Mono" --font-size 14 --theme $THEME --fps-cap 12 --last-frame-duration 4 \
  docs/demo/claude/claude.cast /tmp/claude.gif
ffmpeg -i /tmp/claude.gif -vf "fps=12,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -crf 24 -pix_fmt yuv420p \
  -movflags +faststart -an docs/demo/claude/claude-demo.mp4
```
