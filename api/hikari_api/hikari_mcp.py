from __future__ import annotations

import asyncio
import json
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from .ai import generate_logsql
from .field_mappings import aliases_for, get_field_mappings, normalize_row_aliases, normalize_rows_aliases, summary_facets, with_copy_pipes
from .models import AiQueryRequest
from .settings import Settings, get_settings
from .victorialogs import VictoriaLogsClient

MAX_QUERY_LIMIT = 1000
MAX_FIELD_VALUE_LIMIT = 200
MAX_TAIL_ROWS = 200
MAX_TAIL_SECONDS = 60
SUMMARY_FIELDS = {
    "service": {"field": "service", "label": "Service"},
    "host": {"field": "host", "label": "Host"},
    "hostname": {"field": "hostname", "label": "Hostname"},
    "level": {"field": "level", "label": "Level"},
}


def _field_mappings() -> dict[str, Any]:
    return get_field_mappings(_settings())


def _mapped_query(query: str) -> str:
    return with_copy_pipes(query, _field_mappings())


def _ai_enabled() -> bool:
    return bool(_settings().openai_api_key)


def _transport_security_settings() -> TransportSecuritySettings:
    allowed_hosts = get_settings().mcp_allowed_hosts
    if not allowed_hosts:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)

    allowed_origins = []
    for host in allowed_hosts:
        if "://" in host:
            allowed_origins.append(host)
        else:
            allowed_origins.extend([f"https://{host}", f"http://{host}"])

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
    )


def create_fastmcp_server() -> FastMCP:
    return FastMCP(
        "Hikari",
        instructions=_server_instructions(),
        streamable_http_path="/",
        stateless_http=True,
        json_response=True,
        transport_security=_transport_security_settings(),
    )


def _settings() -> Settings:
    return get_settings()


def _server_instructions() -> str:
    base = (
        "Hikari queries application logs stored in VictoriaLogs. Use field and value discovery before "
        "writing narrow LogsQL."
    )
    if not _ai_enabled():
        return base
    return (
        f"{base} Use ai_search when the user's request needs natural-language mapping "
        "to observed services, Kubernetes metadata, clients, environments, levels, or message text."
    )


def _client(settings: Settings | None = None) -> VictoriaLogsClient:
    return VictoriaLogsClient(settings or _settings())


def _bounded(value: int, default: int, maximum: int) -> int:
    if value <= 0:
        return default
    return min(value, maximum)


def _query_with_limit(query: str, limit: int) -> str:
    if "| limit" in query.lower():
        return query
    return f"{query} | limit {limit}"


hikari_mcp = create_fastmcp_server()


def _rows(result: Any) -> list[dict[str, Any]]:
    rows = result.get("rows", result if isinstance(result, list) else []) if isinstance(result, (dict, list)) else []
    return [row for row in rows if isinstance(row, dict)]


def _values(result: Any) -> list[dict[str, Any]]:
    raw_values = result.get("values", []) if isinstance(result, dict) else result if isinstance(result, list) else []
    return [item for item in raw_values if isinstance(item, dict)]


def _merge_values(*sets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for values in sets:
        for item in values:
            value = str(item.get("value", "")).strip()
            if not value:
                continue
            hits = item.get("hits", item.get("count", 0))
            current = merged.get(value)
            if current is None or int(hits or 0) > int(current.get("hits", 0) or 0):
                merged[value] = {**item, "value": value, "hits": hits}
    return sorted(merged.values(), key=lambda item: (-int(item.get("hits", 0) or 0), str(item.get("value", ""))))


def _summary_field_keys(fields: list[str] | None) -> list[str]:
    config = _field_mappings()
    if not fields:
        return [str(facet.get("key") or facet["field"]) for facet in summary_facets(config)]
    keys: list[str] = []
    for field in fields:
        normalized = field.strip()
        if not normalized:
            continue
        normalized_lower = normalized.lower()
        matching_facet = next(
            (
                facet
                for facet in summary_facets(config)
                if normalized_lower
                in {
                    str(facet.get("key") or facet["field"]).lower(),
                    str(facet["field"]).lower(),
                    str(facet.get("label") or facet["field"]).lower(),
                }
            ),
            None,
        )
        keys.append(str(matching_facet.get("key") or matching_facet["field"]) if matching_facet else normalized)
    return list(dict.fromkeys(keys))


def _facet_fields(fields: list[str] | None) -> list[str]:
    config = _field_mappings()
    if not fields:
        return [str(facet["field"]) for facet in summary_facets(config)]
    mapped: list[str] = []
    for field in fields:
        normalized = field.strip()
        if not normalized:
            continue
        spec = _summary_spec(normalized, config)
        mapped.append(str(spec["field"]))
    return list(dict.fromkeys(mapped))


def _summary_spec(key: str, config: dict[str, Any]) -> dict[str, Any]:
    def unique(values: list[str]) -> list[str]:
        return list(dict.fromkeys(value for value in values if value))

    for facet in summary_facets(config):
        if key.lower() in {str(facet.get("key") or facet["field"]).lower(), str(facet.get("field")).lower(), str(facet.get("label") or facet["field"]).lower()}:
            field = str(facet["field"])
            aliases = aliases_for(config, field)
            return {
                "field": field,
                "fallback_fields": unique([alias for alias in aliases if alias != field]),
                "label": str(facet.get("label") or field),
            }
    fallback = SUMMARY_FIELDS.get(key, {"field": key, "label": key})
    field = str(fallback["field"])
    aliases = aliases_for(config, field)
    return {
        "field": field,
        "fallback_fields": unique([*fallback.get("fallback_fields", []), *[alias for alias in aliases if alias != field]]),
        "label": str(fallback.get("label") or field),
    }


@hikari_mcp.tool(
    name="get_instructions",
    title="Get Instructions",
    description="Explain what Hikari is, how its log fields map to the UI, and which MCP tools to use.",
)
async def get_instructions() -> dict[str, Any]:
    ai_available = _ai_enabled()
    workflow = [
        "Start with summarize_window to understand the current time window.",
        "Use get_field_values or get_facets to inspect specific dimensions before narrowing a query.",
        "Use query_logs when you know the LogsQL to run.",
        "Use tail_logs only for a short bounded sample of fresh activity.",
    ]
    tools = {
        "summarize_window": "UI-like overview of time buckets plus Service, Hostname, Level, Namespace, and Pod counts.",
        "query_logs": "Run bounded raw LogsQL.",
        "get_facets": "Return grouped counts for selected fields.",
        "get_fields": "List available field names.",
        "get_field_values": "List values for one field.",
        "get_hits": "Return hit counts over time.",
        "tail_logs": "Return a bounded live-tail sample.",
    }
    if ai_available:
        workflow.insert(3, "Use ai_search when a human phrase needs to be mapped to observed services, namespaces, pods, levels, or message text.")
        tools["ai_search"] = "Generate LogsQL from natural language and execute it."
    return {
        "system": "Hikari",
        "backend": "VictoriaLogs",
        "default_query": "_time:15m",
        "ai_enabled": ai_available,
        "purpose": "Hikari is a log investigation system for querying Kubernetes and application logs.",
        "workflow": workflow,
        "field_glossary": {
            "Service": "The app/service identity resolved through the configured service field aliases.",
            "Hostname": "The host or node that emitted the log resolved through the configured host field aliases.",
            "Level": "Severity such as error, info, warning, or debug.",
            "Namespace": "Kubernetes namespace from kubernetes.pod_namespace.",
            "Pod": "Kubernetes pod name from kubernetes.pod_name.",
            "Environment": "Deployment environment when present.",
            "Source": "Log source or emitter when present.",
            "Time buckets": "Minute-by-minute hit counts for the query window.",
        },
        "tools": tools,
    }


@hikari_mcp.tool(
    name="query_logs",
    title="Query Logs",
    description="Run a bounded VictoriaLogs LogsQL query and return rows plus basic stats.",
)
async def query_logs(query: str, limit: int = 100, start: str | None = None, end: str | None = None) -> dict[str, Any]:
    """Run bounded LogsQL and normalize configured alias fields in returned rows."""
    bounded_limit = _bounded(limit, 100, MAX_QUERY_LIMIT)
    visible_query = _query_with_limit(query, bounded_limit)
    payload = {"query": _mapped_query(visible_query), "start": start, "end": end}
    result = await _client().query("/select/logsql/query", payload)
    rows = normalize_rows_aliases(_rows(result), _field_mappings())[:bounded_limit]
    return {"query": visible_query, "rows": rows, "stats": {"count": len(rows)}}


@hikari_mcp.tool(
    name="ai_search",
    title="AI Search",
    description="Generate LogsQL from a natural-language prompt, execute it, and return explanation, evidence, and rows.",
)
async def ai_search(
    prompt: str,
    current_query: str | None = None,
    limit: int = 100,
    fields: list[str] | None = None,
) -> dict[str, Any]:
    """Generate LogsQL from a prompt, execute it, and return the evidence trail."""
    settings = _settings()
    vl = _client(settings)
    generated = await generate_logsql(
        settings,
        AiQueryRequest(prompt=prompt, current_query=current_query, fields=fields or []),
        vl,
    )
    bounded_limit = _bounded(limit, 100, MAX_QUERY_LIMIT)
    visible_query = _query_with_limit(generated.query, bounded_limit)
    result = await vl.query("/select/logsql/query", {"query": _mapped_query(visible_query)})
    rows = normalize_rows_aliases(_rows(result), _field_mappings())[:bounded_limit]
    return {
        "query": visible_query,
        "explanation": generated.explanation,
        "evidence": generated.evidence,
        "steps": [step.model_dump() for step in generated.steps],
        "rows": rows,
        "stats": {"count": len(rows)},
    }


@hikari_mcp.tool(
    name="tail_logs",
    title="Tail Logs",
    description="Sample the live VictoriaLogs tail for a bounded duration or row count.",
)
async def tail_logs(query: str = "_time:5m", duration_seconds: int = 10, max_rows: int = 50) -> dict[str, Any]:
    """Collect a bounded live-tail sample for agents that need recent stream data."""
    bounded_seconds = _bounded(duration_seconds, 10, MAX_TAIL_SECONDS)
    bounded_rows = _bounded(max_rows, 50, MAX_TAIL_ROWS)
    rows: list[dict[str, Any]] = []

    try:
        async with asyncio.timeout(bounded_seconds):
            async for line in _client().stream("/select/logsql/tail", {"query": _mapped_query(query)}):
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    parsed = {"_msg": line}
                if isinstance(parsed, dict):
                    rows.append(normalize_row_aliases(parsed, _field_mappings()))
                if len(rows) >= bounded_rows:
                    break
    except TimeoutError:
        pass

    return {"query": query, "rows": rows, "stats": {"count": len(rows), "duration_seconds": bounded_seconds}}


@hikari_mcp.tool(
    name="get_fields",
    title="Get Fields",
    description="List VictoriaLogs field names visible for a query window.",
)
async def get_fields(query: str = "_time:15m", start: str | None = None, end: str | None = None) -> dict[str, Any]:
    return await _client().query("/select/logsql/field_names", {"query": _mapped_query(query), "start": start, "end": end})


@hikari_mcp.tool(
    name="get_field_values",
    title="Get Field Values",
    description="List common values for one VictoriaLogs field within a query window.",
)
async def get_field_values(
    field: str,
    query: str = "_time:15m",
    limit: int = 25,
    start: str | None = None,
    end: str | None = None,
    filter: str | None = None,
) -> dict[str, Any]:
    bounded_limit = _bounded(limit, 25, MAX_FIELD_VALUE_LIMIT)
    return await _client().query(
        "/select/logsql/field_values",
        {"query": _mapped_query(query), "field": field, "limit": bounded_limit, "start": start, "end": end, "filter": filter},
    )


@hikari_mcp.tool(
    name="get_hits",
    title="Get Hits",
    description="Return VictoriaLogs hit counts over time for a LogsQL query.",
)
async def get_hits(query: str, step: str = "1m", start: str | None = None, end: str | None = None) -> dict[str, Any]:
    return await _client().query("/select/logsql/hits", {"query": _mapped_query(query), "step": step, "start": start, "end": end})


@hikari_mcp.tool(
    name="summarize_window",
    title="Summarize Window",
    description="Return the same high-level window summary as the UI: time buckets plus Service, Hostname, Level, Namespace, and Pod counts.",
)
async def summarize_window(
    query: str = "_time:15m",
    step: str = "1m",
    limit: int = 25,
    fields: list[str] | None = None,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    """Return UI-like summary data using bounded parallel field-value lookups."""
    bounded_limit = _bounded(limit, 25, MAX_FIELD_VALUE_LIMIT)
    field_keys = _summary_field_keys(fields)
    vl = _client()
    config = _field_mappings()
    mapped = _mapped_query(query)
    semaphore = asyncio.Semaphore(8)

    async def load_values(field: str) -> list[dict[str, Any]]:
        async with semaphore:
            return _values(
                await vl.query(
                    "/select/logsql/field_values",
                    {"query": mapped, "field": field, "limit": bounded_limit, "start": start, "end": end},
                )
            )

    async def load_facet(key: str) -> tuple[str, dict[str, Any]]:
        spec = _summary_spec(key, config)
        field = spec["field"]
        sources = [field, *spec.get("fallback_fields", [])]
        value_sets = await asyncio.gather(*(load_values(source) for source in sources))
        values = _merge_values(*value_sets)[:bounded_limit]
        return key, {"label": spec["label"], "field": field, "sources": sources, "values": values}

    hits_task = asyncio.create_task(vl.query("/select/logsql/hits", {"query": mapped, "step": step, "start": start, "end": end}))
    facet_entries = await asyncio.gather(*(load_facet(key) for key in field_keys))
    hits = await hits_task
    facets = dict(facet_entries)
    return {"query": query, "step": step, "buckets": hits.get("values", []) if isinstance(hits, dict) else [], "facets": facets}


@hikari_mcp.tool(
    name="get_facets",
    title="Get Facets",
    description="Return VictoriaLogs facets for selected fields; defaults to the Hikari UI summary fields.",
)
async def get_facets(
    query: str,
    fields: list[str] | None = None,
    limit: int = 20,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    """Return facets for requested fields, defaulting to the same summary fields as Hikari."""
    bounded_limit = _bounded(limit, 20, MAX_FIELD_VALUE_LIMIT)
    return await _client().query(
        "/select/logsql/facets",
        {"query": _mapped_query(query), "field": _facet_fields(fields), "limit": bounded_limit, "start": start, "end": end},
    )


@hikari_mcp.prompt(
    name="investigate_hikari_logs",
    title="Investigate Hikari Logs",
    description="Guide an agent through a Hikari log investigation.",
)
def investigate_hikari_logs(request: str, starting_query: str = "_time:15m") -> str:
    ai_instruction = (
        "Use ai_search when the request names a product, service, client, symptom, or natural-language condition "
        "that needs mapping to observed field values or message text. "
        if _ai_enabled()
        else ""
    )
    return (
        f"Investigate Hikari logs for: {request}\n"
        f"Start from LogsQL: {starting_query}\n\n"
        "First call get_instructions to understand Hikari fields and workflow, then call summarize_window "
        "to see the active time buckets, Service, Hostname, Level, Namespace, and Pod counts. "
        "Use get_fields and get_field_values to discover additional structured data before narrowing. "
        "Use query_logs for exact LogsQL searches, get_hits for time distribution, and get_facets for grouping. "
        f"{ai_instruction}Keep returned rows bounded and cite the "
        "query and evidence used."
    )


def create_hikari_mcp() -> FastMCP:
    server = FastMCP(
        "Hikari",
        instructions=_server_instructions(),
        streamable_http_path="/",
        stateless_http=True,
        json_response=True,
        transport_security=_transport_security_settings(),
    )
    server.add_tool(
        get_instructions,
        name="get_instructions",
        title="Get Instructions",
        description="Explain what Hikari is, how its log fields map to the UI, and which MCP tools to use.",
    )
    server.add_tool(
        query_logs,
        name="query_logs",
        title="Query Logs",
        description="Run a bounded VictoriaLogs LogsQL query and return rows plus basic stats.",
    )
    if _ai_enabled():
        server.add_tool(
            ai_search,
            name="ai_search",
            title="AI Search",
            description="Generate LogsQL from a natural-language prompt, execute it, and return explanation, evidence, and rows.",
        )
    server.add_tool(
        tail_logs,
        name="tail_logs",
        title="Tail Logs",
        description="Sample the live VictoriaLogs tail for a bounded duration or row count.",
    )
    server.add_tool(
        get_fields,
        name="get_fields",
        title="Get Fields",
        description="List VictoriaLogs field names visible for a query window.",
    )
    server.add_tool(
        get_field_values,
        name="get_field_values",
        title="Get Field Values",
        description="List common values for one VictoriaLogs field within a query window.",
    )
    server.add_tool(
        get_hits,
        name="get_hits",
        title="Get Hits",
        description="Return VictoriaLogs hit counts over time for a LogsQL query.",
    )
    server.add_tool(
        summarize_window,
        name="summarize_window",
        title="Summarize Window",
        description="Return the same high-level window summary as the UI: time buckets plus Service, Hostname, Level, Namespace, and Pod counts.",
    )
    server.add_tool(
        get_facets,
        name="get_facets",
        title="Get Facets",
        description="Return VictoriaLogs facets for selected fields; defaults to the Hikari UI summary fields.",
    )
    server.prompt(
        name="investigate_hikari_logs",
        title="Investigate Hikari Logs",
        description="Guide an agent through a Hikari log investigation.",
    )(investigate_hikari_logs)
    return server


class HikariMcpASGI:
    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        server = create_hikari_mcp()
        app = server.streamable_http_app()
        async with server.session_manager.run():
            await app(scope, receive, send)


hikari_mcp_app = HikariMcpASGI()
