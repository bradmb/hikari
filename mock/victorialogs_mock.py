from __future__ import annotations

import asyncio
import json
import random
import re
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI(title="Mock VictoriaLogs")

FIELDS = [
    "_time",
    "_msg",
    "level",
    "service",
    "host",
    "status",
    "environment",
    "client",
    "request_id",
    "trace_id",
    "duration_ms",
    "source",
    "logger",
    "kubernetes.pod_namespace",
    "kubernetes.pod_name",
    "kubernetes.container_image",
    "kubernetes.pod_id",
    "kubernetes.pod_ip",
    "kubernetes.pod_labels.app.kubernetes.io/name",
    "kubernetes.pod_labels.controller-revision-hash",
    "kubernetes.pod_labels.pod-template-generation",
    "kubernetes.pod_labels.pod-template-hash",
    "kubernetes.container_name",
    "kubernetes.node_name",
]

SERVICES = ["api-service", "customer-portal", "notification-gateway", "hikari", "deploy-runner", "worker"]
HOSTS = [
    "ip-100-80-8-98.us-east-2.compute.internal",
    "ip-100-82-11-211.us-east-2.compute.internal",
    "ip-100-81-16-28.us-east-2.compute.internal",
    "ip-100-80-51-163.us-east-2.compute.internal",
    "ip-100-81-31-190.us-east-2.compute.internal",
    "ip-100-82-27-166.us-east-2.compute.internal",
    "ip-100-81-26-91.us-east-2.compute.internal",
    "ip-100-80-33-170.us-east-2.compute.internal",
]
LEVELS = ["Information", "Information", "Information", "Warning", "Error", "Debug"]
ENVIRONMENTS = ["production", "production", "staging", "demo"]
CLIENTS = ["alpha", "beta", "gamma", "demo", "partner"]
MESSAGES = [
    "Indexed log batch for search workspace",
    "Completed customer workflow recalculation",
    "Webhook delivery finished",
    "Cache refresh skipped because entries are current",
    "API request completed",
    "Background worker processed queue item",
    "Slow query threshold exceeded",
    "Authentication token refreshed",
    "Edge tunnel health check passed",
    "VictoriaLogs search request proxied",
    "Validation warning on data import",
    "Deployment step completed",
]


async def _form(request: Request) -> dict[str, str]:
    body = (await request.body()).decode("utf-8", errors="replace")
    values = parse_qs(body, keep_blank_values=True)
    return {key: items[-1] for key, items in values.items() if items}


def _rows(count: int = 15 * 500) -> list[dict[str, Any]]:
    anchor = datetime.now(UTC).replace(second=0, microsecond=0) - timedelta(minutes=14)
    rows: list[dict[str, Any]] = []
    rng = random.Random(42)

    for index in range(count):
        minute_index = index // 500
        entry_in_minute = index % 500
        service = SERVICES[index % len(SERVICES)]
        level = LEVELS[(index * 3 + 1) % len(LEVELS)]
        environment = ENVIRONMENTS[(index * 5 + 2) % len(ENVIRONMENTS)]
        client = CLIENTS[(index * 7 + 3) % len(CLIENTS)]
        host = HOSTS[index % len(HOSTS)]
        status = rng.choice([200, 200, 200, 201, 204, 400, 401, 404, 409, 500, 502])
        duration = rng.randint(18, 2400)
        timestamp = anchor + timedelta(minutes=minute_index, milliseconds=entry_in_minute * 120)
        message = MESSAGES[index % len(MESSAGES)]

        if status >= 500:
            level = "Error"
            message = "Upstream dependency returned an error"
        elif status >= 400:
            level = "Warning"
            message = "Request completed with a client-visible warning"
        elif duration > 1800:
            level = "Warning"
            message = "Slow request completed successfully"

        rows.append(
            {
                "_time": timestamp.isoformat().replace("+00:00", "Z"),
                "_msg": f"{message} service={service} client={client} status={status}",
                "level": level,
                "service": service,
                "host": host,
                "status": status,
                "environment": environment,
                "client": client,
                "request_id": f"req-{100000 + index}",
                "trace_id": f"trace-{index % 23:04d}",
                "duration_ms": duration,
                "source": "mock-victorialogs",
                "logger": f"Demo.{service.replace('-', '.').title()}",
                "kubernetes.pod_namespace": "observability" if service == "hikari" else "application",
                "kubernetes.pod_name": f"{service}-{1000 + index % 17}",
                "kubernetes.container_image": f"registry.example.test/{service}:2026.05.{(index % 28) + 1:02d}",
                "kubernetes.pod_id": f"pod-{index % 997:08x}-{index % 389:04x}",
                "kubernetes.pod_ip": f"100.{80 + index % 3}.{index % 255}.{10 + index % 200}",
                "kubernetes.pod_labels.app.kubernetes.io/name": service,
                "kubernetes.pod_labels.controller-revision-hash": f"{service}-{index % 11:08x}",
                "kubernetes.pod_labels.pod-template-generation": str((index % 5) + 1),
                "kubernetes.pod_labels.pod-template-hash": f"{index % 8191:010x}",
                "kubernetes.container_name": service,
                "kubernetes.node_name": host,
            }
        )

    return rows


def _limit(query: str, fallback: int) -> int:
    match = re.search(r"\|\s*limit\s+(\d+)", query, re.IGNORECASE)
    if not match:
        return fallback
    return max(1, min(int(match.group(1)), 5000))


def _matches(row: dict[str, Any], query: str) -> bool:
    normalized = query.lower()
    if normalized.strip() in {"", "*", "_time:15m", "_time:5m"}:
        return True

    checks = re.findall(r"([\w.-]+):\"?([\w./-]+)\"?", query)
    for field, expected in checks:
        if field == "_time":
            continue
        actual = row.get(field)
        if actual is None or str(actual).lower() != expected.lower():
            return False

    terms = [
        term
        for term in re.findall(r'"([^"]+)"|(\b[a-zA-Z][\w.-]{2,}\b)', query)
        for term in term
        if term and not term.startswith("_time") and term.lower() not in {"and", "or", "limit"}
    ]
    if not terms or checks:
        return True

    haystack = json.dumps(row, default=str).lower()
    return all(term.lower() in haystack for term in terms)


def _filtered(query: str) -> list[dict[str, Any]]:
    return [row for row in _rows() if _matches(row, query)]


def _counts(rows: list[dict[str, Any]], field: str, limit: int) -> list[dict[str, Any]]:
    counter = Counter(str(row.get(field, "")) for row in rows if row.get(field) not in (None, ""))
    return [{"value": value, "hits": hits} for value, hits in counter.most_common(limit)]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/select/logsql/query")
async def query(request: Request) -> dict[str, Any]:
    form = await _form(request)
    logsql = form.get("query", "_time:15m")
    rows = _filtered(logsql)[: _limit(logsql, 500)]
    return {"rows": rows, "stats": {"count": len(rows)}}


@app.post("/select/logsql/hits")
async def hits(request: Request) -> dict[str, Any]:
    form = await _form(request)
    logsql = form.get("query", "_time:15m")
    rows = _filtered(logsql)
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    buckets = []
    for minute in range(14, -1, -1):
        bucket_time = now - timedelta(minutes=minute)
        cutoff = bucket_time + timedelta(minutes=1)
        count = sum(1 for row in rows if bucket_time <= datetime.fromisoformat(str(row["_time"]).replace("Z", "+00:00")) < cutoff)
        buckets.append({"time": bucket_time.isoformat().replace("+00:00", "Z"), "hits": count})
    return {"values": buckets}


@app.post("/select/logsql/facets")
async def facets(request: Request) -> dict[str, Any]:
    form = await _form(request)
    logsql = form.get("query", "_time:15m")
    limit = int(form.get("limit", "20"))
    fields = [field for field in form.get("field", "level,service,environment,client,status").split(",") if field]
    rows = _filtered(logsql)
    return {"values": {field: _counts(rows, field, limit) for field in fields}}


@app.post("/select/logsql/field_names")
async def field_names(request: Request) -> dict[str, Any]:
    form = await _form(request)
    rows = _filtered(form.get("query", "_time:15m"))
    return {"values": [{"value": field, "hits": sum(1 for row in rows if field in row)} for field in FIELDS]}


@app.post("/select/logsql/field_values")
async def field_values(request: Request) -> dict[str, Any]:
    form = await _form(request)
    rows = _filtered(form.get("query", "_time:15m"))
    field = form.get("field", "service")
    limit = int(form.get("limit", "50"))
    return {"values": _counts(rows, field, limit)}


@app.post("/select/logsql/tail")
async def tail(request: Request) -> StreamingResponse:
    form = await _form(request)
    query_text = form.get("query", "_time:5m")

    async def stream():
        index = 0
        while True:
            row = _filtered(query_text)[index % max(1, len(_filtered(query_text)))]
            live_row = dict(row)
            live_row["_time"] = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            yield json.dumps(live_row) + "\n"
            index += 1
            await asyncio.sleep(1.5)

    return StreamingResponse(stream(), media_type="application/x-ndjson")
