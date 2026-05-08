# KubeNexus Service Level Objectives

> This document defines the Service Level Objectives (SLOs) and alerting thresholds for the KubeNexus MCP server in production.

---

## SLO Summary

| SLI | SLO Target | Measurement Window |
|---|---|---|
| Availability | 99.5% | Rolling 30 days |
| Tool call p95 latency (reads) | < 2 seconds | Rolling 1 hour |
| Tool call p95 latency (writes) | < 5 seconds | Rolling 1 hour |
| Audit log delivery lag | < 30 seconds | Continuous |
| Auth failure rate | < 0.1% of total calls | Rolling 1 hour |
| Error budget burn rate | < 14.4x | Rolling 1 hour (fast burn) |

---

## SLO 1: Availability

**Definition:** KubeNexus is available if the `/health` endpoint returns HTTP 200 within 5 seconds.

**Target:** 99.5% uptime measured over a rolling 30-day window.

**Error budget:** 3.6 hours of downtime per 30-day period.

**Measurement:**
- Probe: Kubernetes liveness probe + external synthetic check every 30 seconds
- Numerator: Successful health checks
- Denominator: Total health checks

---

## SLO 2: Latency

**Definition:** Time from MCP request receipt to response completion.

**Targets:**
| Operation Type | p50 | p95 | p99 |
|---|---|---|---|
| Read tools (list_pods, get_configmap, etc.) | < 500ms | < 2s | < 5s |
| Write tools (scale_deployment, restart_pod) | < 1s | < 5s | < 10s |
| Multi-cluster routing overhead | < 200ms | < 500ms | < 1s |

**Measurement:** Instrumented in tool handler wrappers, reported to metrics backend.

---

## SLO 3: Audit Log Delivery

**Definition:** Time between a tool invocation and the corresponding audit record being queryable in the log aggregation system (e.g., Azure Log Analytics, Splunk).

**Target:** < 30 seconds for 99% of records.

**Measurement:** Compare `timestamp` field in audit record to ingestion timestamp in the log system.

---

## SLO 4: Authentication Reliability

**Definition:** Percentage of legitimate auth attempts that succeed.

**Target:** < 0.1% auth failure rate (excluding intentionally unauthorized requests).

**Alert threshold:** > 1% auth failures in any 5-minute window → potential attack indicator.

---

## Error Budget Policy

### When the error budget is healthy (> 50% remaining)
- Normal release cadence
- Feature development proceeds

### When the error budget is consumed (20-50% remaining)
- Halt non-critical releases
- Focus engineering effort on reliability improvements

### When the error budget is exhausted (< 20% remaining)
- Freeze all deployments except emergency fixes
- Conduct incident review for any contributing outages
- Platform lead must approve any changes

---

## Burn Rate Alerting

Based on [Google SRE burn rate alerting](https://sre.google/workbook/alerting-on-slos/):

| Alert | Burn Rate | Window | Urgency |
|---|---|---|---|
| `KubeNexusFastBurn` | 14.4x | 1 hour | Page (PagerDuty) |
| `KubeNexusSlowBurn` | 6x | 6 hours | Ticket (high priority) |
| `KubeNexusSteadyBurn` | 3x | 3 days | Ticket (medium priority) |

---

## Dashboards

### KubeNexus Overview Dashboard

| Panel | Metric |
|---|---|
| Availability (30d) | % successful health checks |
| Tool calls / minute | Rate of `ToolInvocation` audit events |
| Error rate | % of tool calls with `status: "failure"` |
| p95 latency | Tool call duration (by tool name) |
| Auth denials | Rate of `status: "denied"` audit events |
| Active clusters | Count from `list_clusters` registry |
| Pod count | `kube_deployment_status_available_replicas{app="kubenexus"}` |
| Top tools | Tool call volume breakdown by name |

### KubeNexus Security Dashboard

| Panel | Metric |
|---|---|
| Auth failures by user OID | Group `denied` events by `userOid` |
| Tool usage by role | Cross-reference tool name with role |
| Unusual volume detection | Deviation from 7-day rolling average |
| Top callers | Audit events grouped by `userOid` |
