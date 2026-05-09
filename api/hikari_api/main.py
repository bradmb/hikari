from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.responses import StreamingResponse

from .ai import generate_logsql
from .field_mappings import (
    SEVERITY_DISPLAY_LEVELS,
    display_severity,
    get_field_mappings,
    normalize_row_aliases,
    normalize_rows_aliases,
    severity_default_missing,
    with_copy_pipes,
)
from .hikari_mcp import hikari_mcp_app
from .models import AiQueryRequest, FacetsRequest, FieldValuesRequest, HitsRequest, SearchRequest, SearchResponse
from .settings import Settings, get_settings
from .victorialogs import VictoriaLogsClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create shared resources that are safe to reuse across normal API requests."""
    settings = get_settings()
    app.state.victoria_http_client = httpx.AsyncClient(timeout=settings.request_timeout_seconds)
    try:
        yield
    finally:
        await app.state.victoria_http_client.aclose()


app = FastAPI(title="Hikari API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def normalize_mcp_path(request: Request, call_next):
    """Accept both /mcp and /mcp/ for clients that do not normalize streamable HTTP URLs."""
    if request.scope.get("path") == "/mcp":
        request.scope["path"] = "/mcp/"
        if request.scope.get("raw_path") == b"/mcp":
            request.scope["raw_path"] = b"/mcp/"
    return await call_next(request)


def client(request: Request, settings: Settings = Depends(get_settings)) -> VictoriaLogsClient:
    """Return a VictoriaLogs client backed by the app-level HTTP connection pool."""
    return VictoriaLogsClient(settings, getattr(request.app.state, "victoria_http_client", None))


def mapped_query(query: str, settings: Settings) -> str:
    """Apply configured query-time field copy pipes before forwarding LogsQL upstream."""
    return with_copy_pipes(query, get_field_mappings(settings))


def ai_enabled(settings: Settings) -> bool:
    """Report whether AI-only UI and MCP tools should be enabled."""
    return bool(settings.openai_api_key)


async def canonical_level_values(query: str, settings: Settings, vl: VictoriaLogsClient, limit: int, start: str | None = None, end: str | None = None) -> list[dict[str, Any]]:
    """Return canonical level counts from VictoriaLogs field values after query-time normalization pipes."""
    field_mappings = get_field_mappings(settings)
    result = await vl.query(
        "/select/logsql/field_values",
        {"query": with_copy_pipes(query, field_mappings), "field": "level", "limit": max(limit, len(SEVERITY_DISPLAY_LEVELS)), "start": start, "end": end},
    )
    totals = {level: 0 for level in SEVERITY_DISPLAY_LEVELS}
    for item in result.get("values", []) if isinstance(result, dict) else []:
        if not isinstance(item, dict):
            continue
        raw_value = item.get("value")
        level = display_severity(raw_value, field_mappings)
        if level is None and raw_value is not None and str(raw_value).strip() == "":
            level = severity_default_missing(field_mappings)
        if level:
            totals[level] = totals.get(level, 0) + int(item.get("hits") or 0)
    return [{"value": level, "hits": hits} for level, hits in totals.items() if hits][:limit]


def _facets_from_result(result: Any) -> list[dict[str, Any]]:
    """Normalize VictoriaLogs facet response variants into the UI/API shape."""
    if not isinstance(result, dict):
        return []
    if isinstance(result.get("facets"), list):
        facets = []
        for facet in result["facets"]:
            if not isinstance(facet, dict):
                continue
            field = facet.get("field") or facet.get("field_name")
            values = facet.get("values")
            if not field or not isinstance(values, list):
                continue
            normalized_values = []
            for item in values:
                if not isinstance(item, dict):
                    continue
                value = item.get("value", item.get("field_value"))
                if value is None:
                    continue
                normalized_values.append({"value": str(value), "hits": int(item.get("hits") or 0)})
            facets.append({"field": str(field), "values": normalized_values})
        return facets
    values = result.get("values")
    if isinstance(values, dict):
        return [
            {"field": field, "values": value}
            for field, value in values.items()
            if isinstance(value, list)
        ]
    return []


@app.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "status": "ok",
        "victoria_url": settings.victoria_url,
        "default_query": settings.default_query,
        "default_fields": settings.default_fields,
    }


@app.get("/api/config")
def config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "default_query": settings.default_query,
        "defaultPage": settings.default_page,
        "fieldMappings": get_field_mappings(settings),
        "facetPreviewLimit": settings.facet_preview_limit,
        "aiEnabled": ai_enabled(settings),
    }


@app.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest, settings: Settings = Depends(get_settings), vl: VictoriaLogsClient = Depends(client)) -> SearchResponse:
    """Run a bounded LogsQL query and normalize configured alias fields in returned rows."""
    field_mappings = get_field_mappings(settings)
    payload = request.model_dump()
    payload["query"] = with_copy_pipes(request.query, field_mappings)
    result = await vl.query("/select/logsql/query", payload)
    rows = result.get("rows", result if isinstance(result, list) else [])
    return SearchResponse(rows=normalize_rows_aliases(rows, field_mappings), stats={"count": len(rows)})


@app.post("/api/hits")
async def hits(request: HitsRequest, settings: Settings = Depends(get_settings), vl: VictoriaLogsClient = Depends(client)) -> Any:
    data = request.model_dump()
    data["query"] = mapped_query(request.query, settings)
    return await vl.query("/select/logsql/hits", data)


@app.post("/api/facets")
async def facets(request: FacetsRequest, settings: Settings = Depends(get_settings), vl: VictoriaLogsClient = Depends(client)) -> Any:
    data = request.model_dump()
    requested_fields = list(data.get("fields") or [])
    if "level" in requested_fields:
        non_level_fields = [field for field in requested_fields if field != "level"]
        response_facets: list[dict[str, Any]] = []
        if non_level_fields:
            non_level_data = {**data, "query": mapped_query(request.query, settings), "field": non_level_fields}
            non_level_data.pop("fields", None)
            result = await vl.query("/select/logsql/facets", non_level_data)
            response_facets.extend(_facets_from_result(result))
        level_values = await canonical_level_values(request.query, settings, vl, data.get("limit", 20), request.start, request.end)
        response_facets.append({"field": "level", "values": level_values})
        return {"facets": response_facets}

    data["query"] = mapped_query(request.query, settings)
    if data["fields"]:
        data["field"] = data.pop("fields")
    return {"facets": _facets_from_result(await vl.query("/select/logsql/facets", data))}


@app.get("/api/fields")
async def fields(
    query: str = Query("_time:15m"),
    start: str | None = None,
    end: str | None = None,
    settings: Settings = Depends(get_settings),
    vl: VictoriaLogsClient = Depends(client),
) -> Any:
    return await vl.query("/select/logsql/field_names", {"query": mapped_query(query, settings), "start": start, "end": end})


@app.get("/api/field-values")
async def field_values(
    field: str,
    query: str = Query("_time:15m"),
    start: str | None = None,
    end: str | None = None,
    filter: str | None = None,
    limit: int = 50,
    settings: Settings = Depends(get_settings),
    vl: VictoriaLogsClient = Depends(client),
) -> Any:
    if field == "level":
        return {"values": await canonical_level_values(query, settings, vl, limit, start, end)}
    request = FieldValuesRequest(query=mapped_query(query, settings), field=field, start=start, end=end, filter=filter, limit=limit)
    return await vl.query("/select/logsql/field_values", request.model_dump())


@app.get("/api/tail")
async def tail(
    query: str = Query("_time:5m"),
    settings: Settings = Depends(get_settings),
    vl: VictoriaLogsClient = Depends(client),
) -> StreamingResponse:
    """Proxy VictoriaLogs tail output as SSE while normalizing aliases row-by-row."""
    field_mappings = get_field_mappings(settings)

    async def events():
        try:
            async for line in vl.stream("/select/logsql/tail", {"query": with_copy_pipes(query, field_mappings)}):
                try:
                    parsed = json.loads(line)
                    if isinstance(parsed, dict):
                        line = json.dumps(normalize_row_aliases(parsed, field_mappings))
                except json.JSONDecodeError:
                    pass
                yield f"data: {line}\n\n"
        except Exception as exc:
            yield f"event: error\ndata: {json.dumps({'message': str(exc)})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/api/ai/query")
async def ai_query(
    request: AiQueryRequest,
    settings: Settings = Depends(get_settings),
    vl: VictoriaLogsClient = Depends(client),
):
    return await generate_logsql(settings, request, vl)


app.mount("/mcp", hikari_mcp_app, name="hikari-mcp")


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: dict[str, Any]) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            is_route_like_path = "." not in Path(path).name
            if exc.status_code == 404 and scope["method"] in {"GET", "HEAD"} and is_route_like_path:
                return await super().get_response("index.html", scope)
            raise


web_dir = Path(__file__).resolve().parents[1] / "web"
if web_dir.exists():
    app.mount("/", SPAStaticFiles(directory=web_dir, html=True), name="web")
