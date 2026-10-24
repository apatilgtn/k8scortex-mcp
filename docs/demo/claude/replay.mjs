// Replays docs/demo/claude/session.json (real Claude Code sessions recorded by record.mjs) at reading speed.
// Prompts, tool calls, results and Claude's answers are shown as recorded. Claude Code's internal
// ToolSearch calls (which load the K8sCortex tool definitions) are skipped; results are shown as a
// one-line preview of the raw text.
//
//   node replay.mjs                       replay in the terminal in real time
//   CAST=out.cast node replay.mjs         write an asciicast v2 file with exact timing instead (no waiting)
//   SCENES=1 ...                          only these scenes (comma-separated numbers), without the audit trail
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const session = JSON.parse(readFileSync(fileURLToPath(new URL("session.json", import.meta.url)), "utf8"));
const CAST = process.env.CAST;
const PICK = process.env.SCENES ? process.env.SCENES.split(",").map(Number) : null;
const FAST = process.env.REPLAY_FAST === "1";
let clock = 0;
const frames = [];
const write = (s) => (CAST ? frames.push([+(clock / 1000).toFixed(3), "o", s.replace(/\n/g, "\r\n")]) : process.stdout.write(s));
const sleep = (ms) => (CAST ? ((clock += ms), Promise.resolve()) : new Promise((r) => setTimeout(r, FAST ? 0 : ms)));
const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", blue: "\x1b[34m", orange: "\x1b[38;5;209m", reset: "\x1b[0m" };
const out = (s = "") => write(s + "\n");
const WIDTH = 116;

function wrap(text, width) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if ((line + " " + word).trim().length > width) { lines.push(line); line = word; }
      else line = (line + " " + word).trim();
    }
    lines.push(line);
  }
  return lines;
}

async function type(text) {
  for (const ch of text) { write(ch); await sleep(16); }
  out();
}

const args = (input) => Object.entries(input ?? {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
const preview = (text, max = WIDTH - 10) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};
const deniedText = (text) => text.replace(/^MCP error -?\d+: /, "").replace(/^Unauthorized to invoke tool: (\w+)\.$/, "Unauthorized to invoke tool: $1 (role)").replace(/^Unauthorized to invoke tool: \w+\. /, "");

out(`${c.orange}${c.bold}✻ Claude Code${c.reset} ${c.bold}+ K8sCortex${c.reset}  ${c.dim}recorded Claude Code sessions, replayed · staging and prod kind clusters${c.reset}`);
out(`${c.dim}  K8sCortex is Claude's only tool. prod policy: any change needs sre · drain_node is disabled${c.reset}`);
await sleep(1500);

let n = 0;
for (const scene of session.scenes) {
  n++;
  if (PICK && !PICK.includes(n)) continue;
  // Chapter marker for players that support them (asciinema-player)
  if (CAST) frames.push([+(clock / 1000).toFixed(3), "m", `${n}. ${scene.title}`]);
  out();
  out(`${c.blue}${c.bold}━━ ${n}/${session.scenes.length}  ${scene.title} ${"━".repeat(Math.max(0, 74 - scene.title.length))}${c.reset}`);
  out(`${c.dim}   ${scene.why}${c.reset}`);
  await sleep(1600);

  for (const step of scene.steps) {
    out();
    write(`${c.bold}${step.who}${c.reset} ${c.dim}(${step.roles.join(", ")})${c.reset} ${c.magenta}>${c.reset} `);
    await type(step.prompt);
    await sleep(500);

    const results = new Map(step.items.filter((i) => i.kind === "result").map((i) => [i.id, i]));
    const hidden = new Set(step.items.filter((i) => i.kind === "call" && i.tool === "ToolSearch").map((i) => i.id));
    for (const item of step.items) {
      if (item.kind === "call" && !hidden.has(item.id)) {
        out(`  ${c.green}●${c.reset} ${c.cyan}${item.tool}${c.reset}${c.dim}(${preview(args(item.input), WIDTH - item.tool.length - 6)})${c.reset}`);
        await sleep(450);
        const r = results.get(item.id);
        if (r) {
          const denied = r.error && /Unauthorized|requires role|disabled on cluster|not permitted/.test(r.text);
          const line = r.error ? `${denied ? c.yellow : c.red}✗ ${preview(deniedText(r.text))}${c.reset}` : `${c.dim}${preview(r.text)}${c.reset}`;
          out(`    ${c.dim}└${c.reset}  ${line}`);
          await sleep(550);
        }
      }
      if (item.kind === "text") {
        const lines = wrap(item.text, WIDTH - 4);
        out(`  ${c.reset}● ${lines[0]}`);
        for (const l of lines.slice(1)) { out(`    ${l}`); await sleep(120); }
        await sleep(750);
      }
    }
  }
}

// ── Audit trail recorded by the server during the sessions (all scenes only) ──
if (PICK) {
  await sleep(4000);
  finish();
}
await sleep(800);
out();
out(`${c.blue}${c.bold}━━ Audit trail ${"━".repeat(68)}${c.reset}`);
out(`${c.dim}   what K8sCortex wrote to stdout during these sessions: one JSON record per call${c.reset}`);
const MUTATING = /^(create|update|delete|scale|restart|suspend|resume|sync|set|cordon|uncordon|drain|taint|remove)_|^rollout_undo$/;
const label = (r) => r.tool + (r.status === "success" && MUTATING.test(r.tool) && r.dryRun !== false ? " (dry run)" : "");
const rows = session.audit.filter((r, i, all) => i === 0 || ["user", "cluster", "status"].some((k) => r[k] !== all[i - 1][k]) || label(r) !== label(all[i - 1]));
for (const r of rows) {
  const colour = r.status === "denied" ? c.yellow : r.status === "success" ? c.green : c.red;
  out(`  ${r.user.padEnd(6)} ${label(r).padEnd(30)} ${String(r.cluster ?? "—").padEnd(13)} ${colour}${r.status}${c.reset}`);
  await sleep(90);
}
const rotation = session.audit.find((r) => r.tool === "update_secret" && r.status === "success");
if (rotation) {
  out();
  out(`  ${c.dim}${JSON.stringify({ user: rotation.user, tool: rotation.tool, cluster: rotation.cluster, stringData: rotation.stringData, status: rotation.status })}${c.reset}`);
}
out();
out(`${c.dim}end of replay${c.reset}`);
await sleep(5000);
finish();

function finish() {
  if (CAST) {
    // A final empty frame holds the last screen until the end of the recording
    frames.push([+(clock / 1000).toFixed(3), "o", ""]);
    const header = { version: 2, width: 150, height: 46, timestamp: Math.floor(Date.parse(session.recordedAt) / 1000), title: "Claude Code + K8sCortex", env: { TERM: "xterm-256color" } };
    writeFileSync(CAST, [JSON.stringify(header), ...frames.map((f) => JSON.stringify(f))].join("\n") + "\n");
  }
  process.exit(0);
}
