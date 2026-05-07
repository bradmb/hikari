from __future__ import annotations

import json
import re
import asyncio
from typing import Any

import httpx
from fastapi import HTTPException

from .field_mappings import get_field_mappings, normalize_rows_aliases, with_copy_pipes
from .models import AiQueryRequest, AiQueryResponse
from .settings import Settings
from .victorialogs import VictoriaLogsClient


DISCOVERY_FIELDS = [
    "environment",
    "service",
    "source",
    "host",
    "hostname",
    "level",
    "severity",
    "severity_text",
    "status",
    "client",
    "kubernetes.pod_namespace",
    "kubernetes.pod_name",
    "kubernetes.container_name",
    "kubernetes.pod_node_name",
    "kubernetes.node_name",
    "kubernetes.pod_labels.app.kubernetes.io/name",
    "kubernetes.pod_labels.k8s-app",
    "kubernetes.pod_labels.app",
]

LEVEL_ALIASES = {
    "error": {"error", "err", "fatal", "critical"},
    "warning": {"warning", "warn"},
    "info": {"info", "information", "informational"},
    "debug": {"debug"},
}


async def generate_logsql(settings: Settings, request: AiQueryRequest, vl: VictoriaLogsClient | None = None) -> AiQueryResponse:
    """Generate or refine LogsQL from natural language using observed VictoriaLogs context."""
    if not settings.openai_api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY or HIKARI_OPENAI_API_KEY_SECRET_ID is required")

    discovery = await _discover_log_context(settings, request, vl)
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["query", "query_changed", "explanation", "evidence"],
        "properties": {
            "query": {"type": "string"},
            "query_changed": {"type": "boolean"},
            "explanation": {"type": "string"},
            "evidence": {
                "type": "array",
                "items": {"type": "string"},
            },
        },
    }
    field_list = ", ".join(request.fields or settings.default_fields)
    prior_conversation = [
        {"role": item.role, "content": item.content}
        for item in request.conversation[-10:]
        if item.role in {"user", "assistant"} and item.content.strip()
    ]
    incident_context = _compact_incident_context(request.incident_context)

    user_input = (
        f"Current LogsQL: {request.current_query or settings.default_query}\n"
        f"Known fields: {field_list}\n"
        f"Request: {request.prompt}\n\n"
        f"Prior conversation:\n{json.dumps(prior_conversation, ensure_ascii=False, indent=2)}\n\n"
        f"Current incident context:\n{json.dumps(incident_context, ensure_ascii=False, indent=2)}\n\n"
        "Observed VictoriaLogs context:\n"
        f"{json.dumps(discovery, ensure_ascii=False, indent=2)}"
    )

    payload = {
        "model": settings.openai_model,
        "instructions": (
            "You are helping investigate VictoriaLogs data. First use the observed fields, field values, "
            "candidate spellings, and sample log rows to infer how the user's terms are represented in "
            "the actual logs. Then return executable LogsQL, a concise explanation, and evidence strings. "
            "Prefer field filters that are supported by observed data. If a user says a product/component "
            "name such as 'Billing API', look for variants such as billing-api, billing_api, billingapi, lowercase, "
            "service names, source names, pod names, hostnames, and message text in the observed context. "
            "Do not simply translate the prompt literally when observed values suggest a different spelling. "
            "When filtering on a structured field, use exact values that appear verbatim in observed field_values "
            "or sample rows. Do not add typo variants or guessed field values to structured field filters. "
            "For severity, use the observed severity field. If severity_text is populated and level is not, "
            "filter on severity_text rather than level. "
            "When prior conversation or incident context is provided, treat the new request as a follow-up. "
            "Use the previous query, explanation, evidence, result totals, and sample rows to refine the search "
            "instead of starting over. "
            "If the follow-up asks for a likely fix, remediation, cause, impact, or next debugging step, answer "
            "the operational incident question directly from the prior context and sample rows. Do not interpret "
            "that as a request to change the LogsQL query unless the user explicitly asks to narrow, broaden, "
            "filter, exclude, or otherwise modify the search. "
            "For follow-up answers that do not require a different search, set query_changed to false, return the "
            "current LogsQL unchanged in query, and put the answer in explanation/evidence. Set query_changed to "
            "true only when the requested answer requires a changed query or result set. "
            "If you need an unobserved spelling variant, use it only as a free-text fallback and say that in evidence. "
            "Always quote structured field values, for example service:\"billing-api\" or "
            "kubernetes.pod_namespace:\"billing-production\". "
            "Keep the current time bound unless the user asks for another range."
        ),
        "input": user_input,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "logsql_query",
                "strict": True,
                "schema": schema,
            }
        },
        "max_output_tokens": 1000,
    }

    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        response = await client.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
            json=payload,
        )
    if response.is_error:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    text = _extract_output_text(response.json())
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="OpenAI response was not valid JSON") from exc
    if parsed.get("query_changed") is False:
        parsed["query"] = request.current_query or settings.default_query
        parsed["steps"] = _build_trace_steps(discovery, parsed)
        return AiQueryResponse.model_validate(parsed)
    parsed = _apply_observed_query_expansions(parsed, discovery, request.prompt)
    parsed["steps"] = _build_trace_steps(discovery, parsed)
    return AiQueryResponse.model_validate(parsed)


def _compact_incident_context(context: dict[str, Any]) -> dict[str, Any]:
    """Trim prior answer context to the fields that help follow-up questions stay grounded."""
    if not isinstance(context, dict) or not context:
        return {}
    compacted: dict[str, Any] = {}
    for key in ("query", "explanation", "evidence", "relaxations", "totalLogs"):
        value = context.get(key)
        if value not in (None, "", []):
            compacted[key] = value
    rows = context.get("rows")
    if isinstance(rows, list):
        compacted["rows"] = [
            _summarize_row(row)
            for row in rows[:12]
            if isinstance(row, dict)
        ]
    return compacted


async def _discover_log_context(settings: Settings, request: AiQueryRequest, vl: VictoriaLogsClient | None) -> dict[str, Any]:
    """Collect field values and representative rows that constrain the AI-generated query."""
    base_query = request.current_query or settings.default_query
    field_mappings = get_field_mappings(settings)
    mapped_base_query = with_copy_pipes(base_query, field_mappings)
    fields = _ordered_fields([*(request.fields or settings.default_fields), *field_mappings.get("defaultFields", [])])
    candidates = _candidate_terms(request.prompt)
    context: dict[str, Any] = {
        "base_query": base_query,
        "candidate_terms": candidates,
        "field_values": {},
        "sample_rows": [],
        "matched_observations": [],
    }
    if vl is None:
        return context

    async def load_field_values(field: str) -> tuple[str, list[dict[str, Any]]]:
        if vl is None:
            return field, []
        try:
            result = await vl.query(
                "/select/logsql/field_values",
                {"query": mapped_base_query, "field": field, "limit": 30},
            )
        except Exception:
            return field, []
        return field, _extract_values(result)

    semaphore = asyncio.Semaphore(8)

    async def bounded_load(field: str) -> tuple[str, list[dict[str, Any]]]:
        async with semaphore:
            return await load_field_values(field)

    field_results = await asyncio.gather(*(bounded_load(field) for field in fields[:18]))
    for field, values in field_results:
        if values:
            context["field_values"][field] = values

    try:
        result = await vl.query("/select/logsql/query", {"query": _with_limit(mapped_base_query, 80)})
        rows = result.get("rows", result if isinstance(result, list) else [])
        normalized_rows = normalize_rows_aliases(rows[:40], field_mappings)
        context["sample_rows"] = [_summarize_row(row) for row in normalized_rows if isinstance(row, dict)]
    except Exception:
        rows = []

    context["matched_observations"] = _matched_observations(candidates, context["field_values"], context["sample_rows"])
    return context


def _ordered_fields(fields: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for field in [*DISCOVERY_FIELDS, *fields]:
        if field and field not in seen:
            seen.add(field)
            ordered.append(field)
    return ordered


def _candidate_terms(prompt: str) -> list[str]:
    """Derive spelling variants from a prompt for matching against observed field values and rows."""
    words = [word for word in re.split(r"[^A-Za-z0-9]+", prompt.strip()) if len(word) > 1]
    phrases: set[str] = set()
    if prompt.strip():
        phrases.add(prompt.strip())
    for size in range(min(4, len(words)), 0, -1):
        for index in range(0, len(words) - size + 1):
            phrase = " ".join(words[index:index + size])
            if len(phrase) > 2:
                phrases.add(phrase)
    variants: set[str] = set()
    for phrase in phrases:
        lower = phrase.lower()
        compact = re.sub(r"[^a-z0-9]+", "", lower)
        dashed = re.sub(r"[^a-z0-9]+", "-", lower).strip("-")
        underscored = re.sub(r"[^a-z0-9]+", "_", lower).strip("_")
        spaced = re.sub(r"\s+", " ", phrase).strip()
        variants.update({spaced, lower, compact, dashed, underscored})
    return [term for term in variants if term][:40]


def _extract_values(result: Any) -> list[dict[str, Any]]:
    raw_values = []
    if isinstance(result, dict):
        raw_values = result.get("values") or result.get("data") or []
    elif isinstance(result, list):
        raw_values = result
    values: list[dict[str, Any]] = []
    for item in raw_values:
        if isinstance(item, dict):
            value = str(item.get("value", "")).strip()
            if value:
                values.append({"value": value, "hits": item.get("hits") or item.get("count")})
        elif item:
            values.append({"value": str(item), "hits": None})
    return values[:30]


def _with_limit(query: str, limit: int) -> str:
    if "| limit" in query.lower():
        return query
    return f"{query} | limit {limit}"


def _summarize_row(row: dict[str, Any]) -> dict[str, Any]:
    preferred_keys = [
        "_time",
        "environment",
        "service",
        "source",
        "host",
        "hostname",
        "level",
        "severity",
        "severity_text",
        "_msg",
        "message",
        "msg",
        "kubernetes.pod_namespace",
        "kubernetes.pod_name",
        "kubernetes.container_name",
        "kubernetes.pod_node_name",
        "kubernetes.pod_labels.app.kubernetes.io/name",
        "kubernetes.pod_labels.k8s-app",
        "kubernetes.pod_labels.app",
    ]
    summary = {key: row[key] for key in preferred_keys if row.get(key) not in (None, "")}
    if summary:
        return summary
    return {key: value for key, value in list(row.items())[:12] if value not in (None, "")}


def _matched_observations(
    candidates: list[str],
    field_values: dict[str, list[dict[str, Any]]],
    sample_rows: list[dict[str, Any]],
) -> list[str]:
    observations: list[str] = []
    lowered_candidates = [candidate.lower() for candidate in candidates]
    for field, values in field_values.items():
        for item in values:
            value = str(item.get("value", ""))
            lowered_value = value.lower()
            if any(candidate and candidate in lowered_value for candidate in lowered_candidates):
                observations.append(f"{field} has observed value {value!r}")
    for row in sample_rows:
        row_text = json.dumps(row, ensure_ascii=False).lower()
        if any(candidate and candidate in row_text for candidate in lowered_candidates):
            observations.append(f"sample row contains candidate term: {json.dumps(row, ensure_ascii=False)[:300]}")
    return observations[:30]


def _apply_observed_query_expansions(parsed: dict[str, Any], discovery: dict[str, Any], prompt: str = "") -> dict[str, Any]:
    """Expand AI level filters to observed severity variants without inventing unavailable values."""
    query = parsed.get("query")
    if not isinstance(query, str):
        return parsed

    expanded_query, expanded_levels = _expand_level_filters(query, discovery, prompt)
    if expanded_query == query:
        return parsed

    updated = {**parsed, "query": expanded_query}
    evidence = list(updated.get("evidence") or [])
    for canonical, values in expanded_levels.items():
        evidence.append(f"Expanded {canonical} level filter to observed values: {', '.join(values)}")
    updated["evidence"] = evidence[:8]
    return updated


def _build_trace_steps(discovery: dict[str, Any], parsed: dict[str, Any]) -> list[dict[str, Any]]:
    field_values = discovery.get("field_values", {})
    sample_rows = discovery.get("sample_rows", [])
    matched_observations = discovery.get("matched_observations", [])
    evidence = parsed.get("evidence") or []

    scanned_fields = list(field_values.keys())
    field_items = []
    for field in scanned_fields[:8]:
        values = field_values.get(field, [])
        preview = ", ".join(str(item.get("value", "")) for item in values[:4] if isinstance(item, dict) and item.get("value"))
        if preview:
            field_items.append(f"{field}: {preview}")

    return [
        {
            "title": "Prepared investigation",
            "status": "done",
            "detail": f"Started from {discovery.get('base_query', '_time:15m')} and generated prompt variants.",
            "items": [str(term) for term in discovery.get("candidate_terms", [])[:8]],
        },
        {
            "title": "Scanned VictoriaLogs fields",
            "status": "done",
            "detail": f"Checked {len(scanned_fields)} fields for real values that match the request.",
            "items": field_items,
        },
        {
            "title": "Sampled recent log rows",
            "status": "done",
            "detail": f"Read {len(sample_rows)} recent rows to see how messages and Kubernetes metadata are represented.",
            "items": [json.dumps(row, ensure_ascii=False)[:180] for row in sample_rows[:3]],
        },
        {
            "title": "Matched observed signals",
            "status": "done",
            "detail": "Mapped the natural language request onto values observed in the log data.",
            "items": [str(item) for item in (matched_observations or evidence)[:6]],
        },
        {
            "title": "Generated and normalized LogsQL",
            "status": "done",
            "detail": parsed.get("explanation", ""),
            "items": [parsed.get("query", "")],
        },
    ]


def _expand_level_filters(query: str, discovery: dict[str, Any], prompt: str = "") -> tuple[str, dict[str, list[str]]]:
    group_pattern = re.compile(r"(?<![\w.])level:\((?P<inner>[^)]+)\)")
    pattern = re.compile(r'(?<![\w.])level:(?:="(?P<exact>[^"]+)"|"(?P<quoted>[^"]+)"|(?P<word>[A-Za-z][\w-]*))')
    expanded: dict[str, list[str]] = {}

    def replace_group(match: re.Match[str]) -> str:
        values = [_unquote_level_filter_value(part) for part in match.group("inner").split(" OR ")]
        canonicals = {_canonical_level(value) for value in values}
        canonicals.discard(None)
        requested = _requested_level_canonical(prompt)
        if len(canonicals) != 1 and requested in canonicals:
            canonical = requested
        elif len(canonicals) == 1:
            canonical = next(iter(canonicals))
        else:
            return match.group(0)

        level_field, observed = _observed_level_field_and_variants(discovery, canonical)
        if len(observed) < 2:
            return match.group(0)

        expanded[canonical] = observed
        quoted = ", ".join(json.dumps(level) for level in observed)
        return f"{level_field}:in({quoted})"

    def replace(match: re.Match[str]) -> str:
        value = match.group("exact") or match.group("quoted") or match.group("word") or ""
        canonical = _canonical_level(value)
        if not canonical:
            return match.group(0)

        level_field, values = _observed_level_field_and_variants(discovery, canonical)
        if len(values) < 2:
            return match.group(0)

        expanded[canonical] = values
        quoted = ", ".join(json.dumps(level) for level in values)
        return f"{level_field}:in({quoted})"

    query = group_pattern.sub(replace_group, query)
    query = pattern.sub(replace, query)
    query = _prune_unrequested_level_filters(query, prompt)
    return _dedupe_or_groups(query), expanded


def _dedupe_or_groups(query: str) -> str:
    query = re.sub(r"(level:in\([^)]+\))(?:\s+(?:OR|or)\s+\1)+", r"\1", query)
    query = re.sub(r"\((level:in\([^)]+\))(?:\s+(?:OR|or)\s+\1)+\)", r"\1", query)
    query = re.sub(r"\((level:in\([^)]+\))\)", r"\1", query)

    def replace(match: re.Match[str]) -> str:
        parts = [part.strip() for part in re.split(r"\s+(?:OR|or)\s+", match.group(1))]
        if len(parts) < 2:
            return match.group(0)
        unique = list(dict.fromkeys(parts))
        if len(unique) == len(parts):
            return match.group(0)
        if len(unique) == 1:
            return unique[0]
        return f"({' OR '.join(unique)})"

    return re.sub(r"\(([^()]+)\)", replace, query)


def _prune_unrequested_level_filters(query: str, prompt: str) -> str:
    requested = _requested_level_canonical(prompt)
    if not requested:
        return query

    def replace_in_filter(match: re.Match[str]) -> str:
        values = [_unquote_level_filter_value(value) for value in match.group(1).split(",")]
        canonicals = {_canonical_level(value) for value in values}
        canonicals.discard(None)
        if canonicals and requested not in canonicals:
            return "__DROP_LEVEL_FILTER__"
        return match.group(0)

    query = re.sub(r"level:in\(([^)]*)\)", replace_in_filter, query)
    query = re.sub(r"\s+(?:OR|or|AND|and)\s+__DROP_LEVEL_FILTER__", "", query)
    query = re.sub(r"__DROP_LEVEL_FILTER__\s+(?:OR|or|AND|and)\s+", "", query)
    query = query.replace("__DROP_LEVEL_FILTER__", "")
    return re.sub(r"\s+", " ", query).strip()


def _canonical_level(value: str) -> str | None:
    lower = value.strip().lower()
    for canonical, aliases in LEVEL_ALIASES.items():
        if lower in aliases:
            return canonical
    return None


def _requested_level_canonical(prompt: str) -> str | None:
    words = set(re.findall(r"[a-zA-Z]+", prompt.lower()))
    if words & {"error", "errors", "err", "fatal", "critical", "exception", "exceptions", "failed", "failure", "failures"}:
        return "error"
    if words & {"warn", "warning", "warnings"}:
        return "warning"
    if words & {"info", "information", "informational"}:
        return "info"
    if words & {"debug", "trace", "verbose"}:
        return "debug"
    return None


def _unquote_level_filter_value(value: str) -> str:
    value = value.strip()
    if value.startswith('="'):
        value = value[2:]
    elif value.startswith("="):
        value = value[1:]
    return value.strip().strip('"').strip("'")


def _observed_level_field_and_variants(discovery: dict[str, Any], canonical: str) -> tuple[str, list[str]]:
    field_values = discovery.get("field_values", {})
    for field in ("level", "severity_text", "severity"):
        values = _level_variants_for_field(field_values.get(field, []), canonical)
        if values:
            return field, values
    return "level", []


def _level_variants_for_field(levels: list[Any], canonical: str) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for item in levels:
        value = str(item.get("value", "")).strip() if isinstance(item, dict) else str(item).strip()
        if not value or _canonical_level(value) != canonical or value in seen:
            continue
        seen.add(value)
        values.append(value)
    return values


def _extract_output_text(response: dict) -> str:
    if isinstance(response.get("output_text"), str):
        return response["output_text"]
    parts: list[str] = []
    for item in response.get("output", []):
        if item.get("type") == "message":
            for content in item.get("content", []):
                if content.get("type") in {"output_text", "text"} and content.get("text"):
                    parts.append(content["text"])
    return "".join(parts)
