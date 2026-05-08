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
    "severity_text",
    "severity_number",
    "severity",
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
JSON_LEVEL_MESSAGES = [
    ("error", "failed to process environ", "open /host/proc/{pid}/environ: no such process"),
    ("warn", "request queue depth high", "queue depth exceeded warning threshold"),
    ("info", "deployment observed", "controller observed deployment state"),
    ("debug", "trace sample flushed", "trace batch sampled for diagnostics"),
]


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

        row = {
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

        if index % 9 == 0:
            json_level, json_message, json_error = JSON_LEVEL_MESSAGES[(index // 9) % len(JSON_LEVEL_MESSAGES)]
            row["_msg"] = json.dumps(
                {
                    "level": json_level,
                    "ts": timestamp.isoformat().replace("+00:00", "Z"),
                    "msg": json_message,
                    "hostname": host,
                    "service": service,
                    "error": json_error.format(pid=7 + index % 120),
                }
            )
            row.pop("level", None)
            row.pop("severity_text", None)
        elif index % 13 == 0:
            row["_msg"] = (
                f"W{timestamp:%m%d} {timestamp:%H:%M:%S}.309809       1 reflector.go:569] "
                "failed to list *v1.VolumeSnapshotClass: the server could not find the requested resource"
            )
            row.pop("level", None)
        elif index % 17 == 0:
            row["_msg"] = (
                f"{timestamp:%Y/%m/%d %H:%M:%S} [warn] 21#21: *1306 a client request body is buffered "
                "to a temporary file /tmp/client_temp/0000000282"
            )
            row.pop("level", None)
        elif index % 7 == 0:
            row["severity_text"] = level
            row.pop("level", None)
        elif index % 11 == 0:
            row["severity_number"] = {"Error": 17, "Warning": 13, "Information": 9, "Debug": 5}.get(level, 9)
            row.pop("level", None)

        rows.append(row)

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


def _query_head(query: str) -> str:
    quote: str | None = None
    for index, char in enumerate(query):
        if char in {"'", '"'} and (index == 0 or query[index - 1] != "\\"):
            quote = None if quote == char else char if quote is None else quote
        elif char == "|" and quote is None:
            return query[:index].strip()
    return query.strip()


def _extract_field(row: dict[str, Any], field: str, value: Any) -> None:
    if value in (None, ""):
        return
    row.setdefault(field, value)


def _apply_query_pipes(row: dict[str, Any], query: str) -> dict[str, Any]:
    next_row = dict(row)
    lower_query = query.lower()

    if "unpack_json" in lower_query:
        try:
            parsed = json.loads(str(next_row.get("_msg", "")))
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            for field in ("level", "severity", "severity_text", "severity_number", "msg", "message"):
                _extract_field(next_row, field, parsed.get(field))
            if "msg" in parsed and "_msg" in next_row:
                next_row.setdefault("message", parsed["msg"])

    klog_match = re.search(r"^(?P<level>[IWEF])[0-9]{4}\s", str(next_row.get("_msg", "")))
    if klog_match and "extract_regexp" in lower_query:
        _extract_field(next_row, "level", klog_match.group("level"))

    bracket_match = re.search(
        r"\[(?P<level>emerg|alert|crit|critical|error|err|warn|warning|notice|info|debug|trace)\]",
        str(next_row.get("_msg", "")),
        re.IGNORECASE,
    )
    if bracket_match and "extract_regexp" in lower_query:
        _extract_field(next_row, "level", bracket_match.group("level"))

    for source, target in re.findall(r"\|\s*copy\s+([^\s|]+)\s+as\s+([^\s|]+)", query, re.IGNORECASE):
        if next_row.get(target) in (None, "") and next_row.get(source) not in (None, ""):
            next_row[target] = next_row[source]

    return next_row


def _split_or(group: str) -> list[str]:
    return [part.strip() for part in re.split(r"\s+OR\s+", group, flags=re.IGNORECASE) if part.strip()]


def _parenthesized_groups(query: str) -> list[tuple[str, str]]:
    groups: list[tuple[str, str]] = []
    start: int | None = None
    depth = 0
    for index, char in enumerate(query):
        if char == "(":
            if depth == 0:
                start = index
            depth += 1
        elif char == ")" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                groups.append((query[start:index + 1], query[start + 1:index]))
                start = None
    return groups


def _atoms_from_text(text: str) -> list[str]:
    atoms: list[str] = []
    atoms.extend(match.group(0) for match in re.finditer(r"[\w./-]+:in\([^)]*\)", text, re.IGNORECASE))
    atoms.extend(match.group(0) for match in re.finditer(r"[\w./-]+:~\"(?:\\.|[^\"])*\"", text, re.IGNORECASE))
    atoms.extend(match.group(0) for match in re.finditer(r"[\w./-]+:~'(?:\\.|[^'])*'", text, re.IGNORECASE))
    without_complex = re.sub(r"[\w./-]+:in\([^)]*\)", " ", text, flags=re.IGNORECASE)
    without_complex = re.sub(r"[\w./-]+:~\"(?:\\.|[^\"])*\"", " ", without_complex, flags=re.IGNORECASE)
    without_complex = re.sub(r"[\w./-]+:~'(?:\\.|[^'])*'", " ", without_complex, flags=re.IGNORECASE)
    atoms.extend(match.group(0) for match in re.finditer(r"[\w./-]+:=?\"?[^\"\s)]*\"?", without_complex, re.IGNORECASE))
    return [atom for atom in atoms if not atom.startswith("_time:")]


def _field_matches(row: dict[str, Any], field: str, operator: str, expected: str) -> bool:
    if field == "_time":
        return True
    actual = row.get(field)
    if operator == "~":
        return actual is not None and re.search(expected, str(actual), re.IGNORECASE) is not None
    if operator == "in":
        values = [item.strip().strip('"').strip("'") for item in expected.split(",") if item.strip()]
        return actual is not None and str(actual).lower() in {value.lower() for value in values}
    if expected == "":
        return actual in (None, "")
    if field == "_msg":
        return expected.lower() in str(actual or "").lower()
    return actual is not None and str(actual).lower() == expected.lower()


def _canonical_level(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"error", "err", "fatal", "critical", "crit", "alert", "emerg", "e", "f"}:
        return "error"
    if normalized in {"warning", "warn", "notice", "w"}:
        return "warning"
    if normalized in {"info", "information", "informational", "i"}:
        return "info"
    if normalized in {"debug", "trace", "verbose"}:
        return "debug"
    return normalized


def _requested_level(filter_query: str) -> str:
    lowered = filter_query.lower()
    if "level:in" not in lowered:
        return ""
    if '"error"' in lowered or '"err"' in lowered:
        return "error"
    if '"warning"' in lowered or '"warn"' in lowered:
        return "warning"
    if '"info"' in lowered or '"information"' in lowered:
        return "info"
    if '"debug"' in lowered or '"trace"' in lowered or '"verbose"' in lowered:
        return "debug"
    return ""


def _atom_matches(row: dict[str, Any], atom: str) -> bool:
    atom = atom.strip()
    if not atom or atom.upper() in {"AND", "OR"}:
        return True
    in_match = re.fullmatch(r"([\w./-]+):in\((.*)\)", atom, re.IGNORECASE)
    if in_match:
        return _field_matches(row, in_match.group(1), "in", in_match.group(2))
    regex_match = re.fullmatch(r"([\w./-]+):~\"((?:\\.|[^\"])*)\"", atom, re.IGNORECASE)
    if regex_match:
        return _field_matches(row, regex_match.group(1), "~", regex_match.group(2))
    regex_match = re.fullmatch(r"([\w./-]+):~'((?:\\.|[^'])*)'", atom, re.IGNORECASE)
    if regex_match:
        return _field_matches(row, regex_match.group(1), "~", regex_match.group(2))
    field_match = re.fullmatch(r"([\w./-]+):=?\"?([^\"\s)]*)\"?", atom, re.IGNORECASE)
    if field_match:
        return _field_matches(row, field_match.group(1), "=", field_match.group(2))
    haystack = json.dumps(row, default=str).lower()
    return atom.strip('"').lower() in haystack


def _matches(row: dict[str, Any], query: str) -> bool:
    filter_query = _query_head(query)
    normalized = filter_query.lower()
    if normalized.strip() in {"", "*", "_time:15m", "_time:5m"}:
        return True

    requested_level = _requested_level(filter_query)
    if requested_level:
        transformed = _apply_query_pipes(row, query)
        if _canonical_level(transformed.get("level")) != requested_level:
            return False
        for full_group, group in _parenthesized_groups(filter_query):
            if "level:in" in group.lower():
                filter_query = filter_query.replace(full_group, " ")
        if not _atoms_from_text(filter_query):
            return True

    for full_group, group in _parenthesized_groups(filter_query):
        if " OR " not in group.upper():
            continue
        if not any(_atom_matches(row, atom) for atom in _atoms_from_text(group)):
            return False
        filter_query = filter_query.replace(full_group, " ")

    atoms = _atoms_from_text(filter_query)
    field_atoms = [atom for atom in atoms if ":" in atom]
    for atom in field_atoms:
        if not _atom_matches(row, atom):
            return False

    terms = [
        term
        for term in re.findall(r'"([^"]+)"|(\b[a-zA-Z][\w.-]{2,}\b)', filter_query)
        for term in term
        if term and not term.startswith("_time") and term.lower() not in {"and", "or", "limit"} and ":" not in term
    ]
    if not terms or field_atoms:
        return True

    haystack = json.dumps(row, default=str).lower()
    return all(term.lower() in haystack for term in terms)


def _filtered(query: str) -> list[dict[str, Any]]:
    return [_apply_query_pipes(row, query) for row in _rows() if _matches(row, query)]


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
    values = {field: _counts(rows, field, limit) for field in fields}
    return {
        "values": values,
        "facets": [{"field": field, "values": field_values} for field, field_values in values.items()],
    }


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
