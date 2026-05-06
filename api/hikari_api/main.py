from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse

from .ai import generate_logsql
from .hikari_mcp import hikari_mcp_app
from .models import AiQueryRequest, FacetsRequest, FieldValuesRequest, HitsRequest, SearchRequest, SearchResponse
from .settings import Settings, get_settings
from .victorialogs import VictoriaLogsClient

app = FastAPI(title="Hikari API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def normalize_mcp_path(request: Request, call_next):
    if request.scope.get("path") == "/mcp":
        request.scope["path"] = "/mcp/"
        if request.scope.get("raw_path") == b"/mcp":
            request.scope["raw_path"] = b"/mcp/"
    return await call_next(request)


def client(settings: Settings = Depends(get_settings)) -> VictoriaLogsClient:
    return VictoriaLogsClient(settings)


@app.get("/health")
def health(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {
        "status": "ok",
        "victoria_url": settings.victoria_url,
        "default_query": settings.default_query,
        "default_fields": settings.default_fields,
    }


@app.post("/api/search", response_model=SearchResponse)
async def search(request: SearchRequest, vl: VictoriaLogsClient = Depends(client)) -> SearchResponse:
    payload = request.model_dump(exclude={"limit"})
    query = payload["query"]
    if "limit" not in query:
        payload["query"] = f"{query} | limit {request.limit}"
    result = await vl.query("/select/logsql/query", payload)
    rows = result.get("rows", result if isinstance(result, list) else [])
    return SearchResponse(rows=rows, stats={"count": len(rows)})


@app.post("/api/hits")
async def hits(request: HitsRequest, vl: VictoriaLogsClient = Depends(client)) -> Any:
    return await vl.query("/select/logsql/hits", request.model_dump())


@app.post("/api/facets")
async def facets(request: FacetsRequest, vl: VictoriaLogsClient = Depends(client)) -> Any:
    data = request.model_dump()
    if data["fields"]:
        data["field"] = data.pop("fields")
    return await vl.query("/select/logsql/facets", data)


@app.get("/api/fields")
async def fields(
    query: str = Query("_time:15m"),
    start: str | None = None,
    end: str | None = None,
    vl: VictoriaLogsClient = Depends(client),
) -> Any:
    return await vl.query("/select/logsql/field_names", {"query": query, "start": start, "end": end})


@app.get("/api/field-values")
async def field_values(
    field: str,
    query: str = Query("_time:15m"),
    start: str | None = None,
    end: str | None = None,
    filter: str | None = None,
    limit: int = 50,
    vl: VictoriaLogsClient = Depends(client),
) -> Any:
    request = FieldValuesRequest(query=query, field=field, start=start, end=end, filter=filter, limit=limit)
    return await vl.query("/select/logsql/field_values", request.model_dump())


@app.get("/api/tail")
async def tail(
    query: str = Query("_time:5m"),
    vl: VictoriaLogsClient = Depends(client),
) -> StreamingResponse:
    async def events():
        try:
            async for line in vl.stream("/select/logsql/tail", {"query": query}):
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


web_dir = Path(__file__).resolve().parents[1] / "web"
if web_dir.exists():
    app.mount("/", StaticFiles(directory=web_dir, html=True), name="web")
