from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class QueryWindow(BaseModel):
    query: str = Field(..., min_length=1)
    start: str | None = None
    end: str | None = None


class SearchRequest(QueryWindow):
    limit: int = Field(500, ge=1, le=5000)


class HitsRequest(QueryWindow):
    step: str = "1m"


class FacetsRequest(QueryWindow):
    fields: list[str] = Field(default_factory=list)
    limit: int = Field(20, ge=1, le=100)


class FieldValuesRequest(QueryWindow):
    field: str = Field(..., min_length=1)
    filter: str | None = None
    limit: int = Field(50, ge=1, le=500)


class AiConversationMessage(BaseModel):
    role: str
    content: str


class AiQueryRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    current_query: str | None = None
    fields: list[str] = Field(default_factory=list)
    conversation: list[AiConversationMessage] = Field(default_factory=list)
    incident_context: dict[str, Any] = Field(default_factory=dict)


class AiTraceStep(BaseModel):
    title: str
    status: str = "done"
    detail: str = ""
    tool: str | None = None
    items: list[str] = Field(default_factory=list)


class AiQueryResponse(BaseModel):
    query: str
    query_changed: bool = True
    explanation: str
    evidence: list[str] = Field(default_factory=list)
    steps: list[AiTraceStep] = Field(default_factory=list)


class SearchResponse(BaseModel):
    rows: list[dict[str, Any]]
    stats: dict[str, Any] = Field(default_factory=dict)
