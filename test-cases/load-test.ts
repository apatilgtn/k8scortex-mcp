import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const TARGET = process.env.TARGET || "http://localhost:3001/mcp";
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "10");
const DURATION_S = parseInt(process.env.DURATION || "30");
const TOOLS = [
  { name: "list_pods", arguments: { namespace: "default" } },
  { name: "list_nodes", arguments: {} },
  { name: "list_clusters", arguments: {} },
  { name: "get_cluster_info", arguments: { cluster: "default" } },
  { name: "list_events", arguments: { namespace: "default" } },
];

interface Stats {
  total: number;
  success: number;
  failure: number;
  latencies: number[];
}

async function runWorker(workerId: number, stats: Stats, endTime: number): Promise<void> {
  const transport = new SSEClientTransport(new URL(TARGET));
  const client = new Client({ name: `load-worker-${workerId}`, version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err: any) {
    console.error(`Worker ${workerId} failed to connect: ${err.message}`);
    return;
  }

  while (Date.now() < endTime) {
    const tool = TOOLS[Math.floor(Math.random() * TOOLS.length)];
    const start = performance.now();

    try {
      await client.callTool(tool);
      const elapsed = performance.now() - start;
      stats.total++;
      stats.success++;
      stats.latencies.push(elapsed);
    } catch (err: any) {
      const elapsed = performance.now() - start;
      stats.total++;
      stats.failure++;
      stats.latencies.push(elapsed);
    }
  }
}

async function main() {
  console.log(`\n🚀 KubeNexus Load Test`);
  console.log(`   Target:      ${TARGET}`);
  console.log(`   Concurrency: ${CONCURRENCY} workers`);
  console.log(`   Duration:    ${DURATION_S} seconds\n`);

  const stats: Stats = { total: 0, success: 0, failure: 0, latencies: [] };
  const endTime = Date.now() + DURATION_S * 1000;

  const workers = Array.from({ length: CONCURRENCY }, (_, i) =>
    runWorker(i, stats, endTime)
  );

  await Promise.all(workers);

  // Calculate percentiles
  stats.latencies.sort((a, b) => a - b);
  const p50 = stats.latencies[Math.floor(stats.latencies.length * 0.5)] || 0;
  const p95 = stats.latencies[Math.floor(stats.latencies.length * 0.95)] || 0;
  const p99 = stats.latencies[Math.floor(stats.latencies.length * 0.99)] || 0;
  const avg = stats.latencies.reduce((a, b) => a + b, 0) / (stats.latencies.length || 1);

  console.log(`\n📊 Results`);
  console.log(`   Total calls:  ${stats.total}`);
  console.log(`   Success:      ${stats.success}`);
  console.log(`   Failures:     ${stats.failure}`);
  console.log(`   Error rate:   ${((stats.failure / stats.total) * 100).toFixed(2)}%`);
  console.log(`   Throughput:   ${(stats.total / DURATION_S).toFixed(1)} calls/sec`);
  console.log(`\n⏱  Latency`);
  console.log(`   Avg:  ${avg.toFixed(0)} ms`);
  console.log(`   p50:  ${p50.toFixed(0)} ms`);
  console.log(`   p95:  ${p95.toFixed(0)} ms`);
  console.log(`   p99:  ${p99.toFixed(0)} ms`);

  // SLO check
  const sloPass = p95 < 2000 && (stats.failure / stats.total) < 0.05;
  console.log(`\n${sloPass ? "✅" : "❌"} SLO Check: p95 < 2s = ${p95 < 2000 ? "PASS" : "FAIL"}, error rate < 5% = ${(stats.failure / stats.total) < 0.05 ? "PASS" : "FAIL"}\n`);

  process.exit(sloPass ? 0 : 1);
}

main().catch(console.error);
