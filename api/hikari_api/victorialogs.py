from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import HTTPException

from .settings import Settings


class VictoriaLogsClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.base_url = settings.victoria_url.rstrip("/")

    def _headers(self) -> dict[str, str]:
        headers = dict(self.settings.victoria_headers)
        if self.settings.victoria_bearer_token:
            headers["Authorization"] = f"Bearer {self.settings.victoria_bearer_token}"
        return headers

    async def query(self, path: str, data: dict[str, Any]) -> Any:
        async with httpx.AsyncClient(timeout=self.settings.request_timeout_seconds) as client:
            response = await client.post(f"{self.base_url}{path}", data=_compact_form(data), headers=self._headers())
        if response.is_error:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        return _parse_response(response)

    async def stream(self, path: str, data: dict[str, Any]) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{self.base_url}{path}", data=_compact_form(data), headers=self._headers()) as response:
                if response.is_error:
                    body = await response.aread()
                    raise HTTPException(status_code=response.status_code, detail=body.decode("utf-8", errors="replace"))
                async for line in response.aiter_lines():
                    if line:
                        yield line


def _compact_form(data: dict[str, Any]) -> dict[str, str]:
    compacted: dict[str, str] = {}
    for key, value in data.items():
        if value is None or value == "" or value == []:
            continue
        if isinstance(value, list):
            compacted[key] = ",".join(str(item) for item in value)
        else:
            compacted[key] = str(value)
    return compacted


def _parse_response(response: httpx.Response) -> Any:
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        return response.json()

    text = response.text.strip()
    if not text:
        return {}

    rows: list[Any] = []
    for line in text.splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append({"_msg": line})
    return {"rows": rows}
