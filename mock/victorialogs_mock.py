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
    "service_name",
    "host",
    "host_name",
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
ROWS_CACHE: tuple[datetime, int, list[dict[str, Any]]] | None = None


async def _form(request: Request) -> dict[str, str]:
    body = (await request.body()).decode("utf-8", errors="replace")
    values = parse_qs(body, keep_blank_values=True)
    return {key: items[-1] for key, items in values.items() if items}


def _rows(count: int = 15 * 500) -> list[dict[str, Any]]:
    global ROWS_CACHE
    anchor = datetime.now(UTC).replace(second=0, microsecond=0) - timedelta(minutes=14)
    if ROWS_CACHE and ROWS_CACHE[0] == anchor and ROWS_CACHE[1] == count:
        return ROWS_CACHE[2]

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
                "service_name": service,
                "host": host,
                "host_name": host,
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

    ROWS_CACHE = (anchor, count, rows)
    return rows


def _limit(query: str, fallback: int) -> int:
    match = re.search(r"\|\s*limit\s+(\d+)", query, re.IGNORECASE)
    if not match:
        return fallback
    return max(1, min(int(match.group(1)), 5000))


def _request_limit(form: dict[str, str], fallback: int) -> int:
    if form.get("limit"):
        return max(1, min(int(form["limit"]), 5000))
    return _limit(form.get("query", ""), fallback)


def _duration_seconds(value: str, fallback: int) -> int:
    match = re.search(r"(\d+)([smhd])", value, re.IGNORECASE)
    if not match:
        return fallback
    amount = int(match.group(1))
    unit = match.group(2).lower()
    multipliers = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    return max(1, amount * multipliers[unit])


def _matches(row: dict[str, Any], query: str) -> bool:
    filter_query = query.split("|", 1)[0].strip()
    normalized = filter_query.lower()
    if normalized.strip() in {"", "*", "_time:15m", "_time:5m"}:
        return True

    def check_field(field: str, expected: str) -> bool:
        if field == "_time":
            return True
        actual = row.get(field)
        return actual is not None and str(actual).lower() == expected.lower()

    or_groups = re.findall(r"\(([^()]*\bOR\b[^()]*)\)", filter_query, re.IGNORECASE)
    for group in or_groups:
        group_checks = re.findall(r"([\w./-]+):\"?([\w./-]+)\"?", group)
        if group_checks and not any(check_field(field, expected) for field, expected in group_checks):
            return False
        filter_query = filter_query.replace(f"({group})", " ")

    checks = re.findall(r"([\w./-]+):\"?([\w./-]+)\"?", filter_query)
    for field, expected in checks:
        if not check_field(field, expected):
            return False

    terms = [
        term
        for term in re.findall(r'"([^"]+)"|(\b[a-zA-Z][\w.-]{2,}\b)', filter_query)
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
    rows = sorted(_filtered(logsql), key=lambda row: str(row.get("_time", "")), reverse=True)[: _request_limit(form, 500)]
    return {"rows": rows, "stats": {"count": len(rows)}}


@app.post("/select/logsql/hits")
async def hits(request: Request) -> dict[str, Any]:
    form = await _form(request)
    logsql = form.get("query", "_time:15m")
    rows = _filtered(logsql)
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    span_seconds = _duration_seconds(logsql, 15 * 60)
    step_seconds = _duration_seconds(form.get("step", "1m"), 60)
    bucket_count = max(1, min(240, (span_seconds + step_seconds - 1) // step_seconds))
    buckets = []
    start = now - timedelta(seconds=bucket_count * step_seconds)
    for index in range(bucket_count):
        bucket_time = start + timedelta(seconds=index * step_seconds)
        cutoff = bucket_time + timedelta(seconds=step_seconds)
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
            rows = _filtered(query_text)
            row = rows[index % max(1, len(rows))]
            live_row = dict(row)
            live_row["_time"] = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            yield json.dumps(live_row) + "\n"
            index += 1
            await asyncio.sleep(1.5)

    return StreamingResponse(stream(), media_type="application/x-ndjson")
