from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from hikari_api import ai
from hikari_api import hikari_mcp
from hikari_api.field_mappings import expand_level_filters, get_field_mappings, normalize_row_aliases, with_copy_pipes
from hikari_api.main import app
from hikari_api.models import AiQueryRequest, AiQueryResponse
from hikari_api.settings import Settings, get_settings

TEST_FIELD_MAPPINGS = {
    "defaultFields": [
        "environment",
        "service",
        "service.name",
        "service_name",
        "host",
        "hostname",
        "host.name",
        "host_name",
        "MachineName",
        "level",
        "source",
        "status",
        "client",
        "kubernetes.pod_namespace",
        "kubernetes.pod_name",
        "kubernetes.pod_node_name",
        "kubernetes.node_name",
        "kubernetes.container_name",
        "kubernetes.pod_labels.app.kubernetes.io/name",
        "kubernetes.pod_labels.k8s-app",
        "kubernetes.pod_labels.app",
    ],
    "aliases": {
        "environment": ["environment", "env", "Environment"],
        "service": [
            "service",
            "service.name",
            "service_name",
            "app",
            "kubernetes.pod_labels.app.kubernetes.io/name",
            "kubernetes.pod_labels.k8s-app",
            "kubernetes.pod_labels.app",
            "kubernetes.pod_labels.app.kubernetes.io/component",
            "kubernetes.container_name",
            "source",
        ],
        "host": ["host", "hostname", "host.name", "host_name", "MachineName", "kubernetes.pod_node_name", "kubernetes.node_name"],
        "hostname": ["hostname", "host", "host.name", "host_name", "MachineName", "kubernetes.pod_node_name", "kubernetes.node_name"],
        "level": ["level", "severity_text", "SeverityText", "severity", "Severity", "severity_number", "SeverityNumber"],
        "kubernetes.pod_namespace": ["kubernetes.pod_namespace", "namespace"],
        "kubernetes.pod_name": ["kubernetes.pod_name", "pod"],
    },
    "severity": {
        "canonicalField": "level",
        "textFields": ["level", "severity_text", "SeverityText", "severity", "Severity"],
        "numberFields": ["severity_number", "SeverityNumber"],
        "values": {
            "error": ["error", "err", "fatal", "critical", "crit", "alert", "emerg", "e", "f"],
            "warning": ["warning", "warn", "notice", "w"],
            "info": ["info", "information", "informational", "i"],
            "debug": ["debug", "trace", "verbose"],
        },
        "messageFilters": {
            "error": ['_msg:~\'"level"[[:space:]]*:[[:space:]]*"(error|err|fatal|critical|crit|alert|emerg)\'', "_msg:~'[[](emerg|alert|crit|critical|error|err)[]]'", "_msg:~'^E[0-9]{4}'", "_msg:~'^F[0-9]{4}'"],
            "warning": ['_msg:~\'"level"[[:space:]]*:[[:space:]]*"(warn|warning|notice)\'', "_msg:~'[[](warn|warning|notice)[]]'", "_msg:~'^W[0-9]{4}'"],
            "info": ['_msg:~\'"level"[[:space:]]*:[[:space:]]*"(info|information|informational)\'', "_msg:~'^I[0-9]{4}'"],
            "debug": ['_msg:~\'"level"[[:space:]]*:[[:space:]]*debug\''],
        },
        "numberRanges": {
            "debug": [1, 8],
            "info": [9, 12],
            "warning": [13, 16],
            "error": [17, 24],
        },
        "extractPipes": [
            "unpack_json fields (level,severity,severity_text,severity_number,msg,message) keep_original_fields",
            "extract_regexp '^(?P<level>[IWEF])[0-9]{4}[[:space:]]' from _msg keep_original_fields",
            "extract_regexp '^(?P<level>INFO|WARN|WARNING|ERROR|ERR|DEBUG|TRACE|VERBOSE|FATAL|CRITICAL|emerg|alert|crit|critical|error|err|warn|warning|notice|info|debug|trace|verbose|fatal)[[:space:]:]' from _msg keep_original_fields",
            "extract_regexp '[[](?P<level>emerg|alert|crit|critical|error|err|warn|warning|notice|info|debug|trace)[]]' from _msg keep_original_fields",
        ],
    },
    "facets": [
        {"field": "environment", "label": "Environment"},
        {"field": "service", "label": "Service", "summary": True},
        {"field": "host", "label": "Host", "summary": True},
        {"field": "level", "label": "Level", "summary": True},
        {"field": "source", "label": "Source"},
        {"field": "kubernetes.pod_namespace", "key": "namespace", "label": "Namespace", "summary": True},
        {"field": "kubernetes.pod_name", "key": "pod", "label": "Pod", "summary": True},
    ],
}


class FakeVictoriaLogsClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def query(self, path: str, data: dict):
        self.calls.append((path, data))
        if path == "/select/logsql/query":
            return {"rows": [{"_time": "2026-05-01T18:00:00Z", "_msg": "hello", "service": "api"}]}
        if path == "/select/logsql/hits":
            return {"values": [{"timestamp": "2026-05-01T18:00:00Z", "hits": 4}]}
        if path == "/select/logsql/facets":
            return {"facets": [{"field": "service", "values": [{"value": "api", "hits": 2}]}]}
        if path == "/select/logsql/field_values":
            return {"values": [{"value": "api", "hits": 2}]}
        if path == "/select/logsql/field_names":
            return {"values": [{"value": "service", "hits": 2}]}
        return {}

    async def stream(self, path: str, data: dict):
        if False:
            yield ""
        raise RuntimeError("tail failed")


def override_client() -> FakeVictoriaLogsClient:
    return FakeVictoriaLogsClient()


def override_settings() -> Settings:
    return Settings(
        HIKARI_VICTORIA_URL="http://victorialogs",
        HIKARI_DEFAULT_QUERY="_time:15m",
        HIKARI_DEFAULT_FIELDS="service,level",
        HIKARI_FIELD_MAPPINGS=TEST_FIELD_MAPPINGS,
        OPENAI_API_KEY="test-key",
    )


def override_settings_without_ai() -> Settings:
    return Settings(
        HIKARI_VICTORIA_URL="http://victorialogs",
        HIKARI_DEFAULT_QUERY="_time:15m",
        HIKARI_DEFAULT_FIELDS="service,level",
        HIKARI_FIELD_MAPPINGS=TEST_FIELD_MAPPINGS,
        _env_file=None,
        OPENAI_API_KEY="",
    )


def mappings_with_default_missing(default: str | None = "info") -> dict:
    config = json.loads(json.dumps(TEST_FIELD_MAPPINGS))
    if default is None:
        config["severity"]["defaultMissing"] = None
    else:
        config["severity"]["defaultMissing"] = default
    return config


def override_settings_default_missing_info() -> Settings:
    return Settings(
        HIKARI_VICTORIA_URL="http://victorialogs",
        HIKARI_DEFAULT_QUERY="_time:15m",
        HIKARI_DEFAULT_FIELDS="service,level",
        HIKARI_FIELD_MAPPINGS=mappings_with_default_missing("info"),
        OPENAI_API_KEY="test-key",
    )


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def overrides():
    from hikari_api.main import client

    app.dependency_overrides[client] = override_client
    app.dependency_overrides[get_settings] = override_settings
    yield
    app.dependency_overrides.clear()


def test_search_proxies_query_endpoint():
    with TestClient(app) as test_client:
        response = test_client.post("/api/search", json={"query": "_time:15m", "limit": 100})
    assert response.status_code == 200
    assert response.json()["rows"][0]["service"] == "api"


def test_search_sends_limit_as_api_parameter():
    fake = FakeVictoriaLogsClient()

    def override_fake_client() -> FakeVictoriaLogsClient:
        return fake

    from hikari_api.main import client

    app.dependency_overrides[client] = override_fake_client
    with TestClient(app) as test_client:
        response = test_client.post("/api/search", json={"query": "_time:15m", "limit": 100})
    assert response.status_code == 200
    path, payload = fake.calls[0]
    assert path == "/select/logsql/query"
    assert payload["start"] is None
    assert payload["end"] is None
    assert payload["limit"] == 100
    assert payload["query"].startswith("_time:15m | unpack_json")
    assert "copy service.name as service" in payload["query"]
    assert "copy host_name as host" in payload["query"]


def test_search_normalizes_configured_aliases_in_rows():
    class AliasOnlyClient(FakeVictoriaLogsClient):
        async def query(self, path: str, data: dict):
            self.calls.append((path, data))
            return {
                "rows": [
                    {
                        "_time": "2026-05-07T02:44:37Z",
                        "_msg": "windows event",
                        "service_name": "windows-event-log",
                        "host_name": "workstation-01",
                    }
                ]
            }

    fake = AliasOnlyClient()

    def override_fake_client():
        return fake

    from hikari_api.main import client

    app.dependency_overrides[client] = override_fake_client
    with TestClient(app) as test_client:
        response = test_client.post("/api/search", json={"query": "_time:15m", "limit": 100})

    row = response.json()["rows"][0]
    assert row["service"] == "windows-event-log"
    assert row["host"] == "workstation-01"
    assert row["service_name"] == "windows-event-log"
    assert row["host_name"] == "workstation-01"


def test_search_does_not_derive_level_from_message_when_structured_level_is_missing():
    class MessageOnlyLevelClient(FakeVictoriaLogsClient):
        async def query(self, path: str, data: dict):
            self.calls.append((path, data))
            return {
                "rows": [
                    {
                        "_time": "2026-05-08T00:09:11Z",
                        "_msg": "2026-05-08 00:09:11 UTC | CLUSTER | ERROR | failed to reconcile",
                        "service": "controller",
                    }
                ]
            }

    fake = MessageOnlyLevelClient()

    def override_fake_client():
        return fake

    from hikari_api.main import client

    app.dependency_overrides[client] = override_fake_client
    with TestClient(app) as test_client:
        response = test_client.post("/api/search", json={"query": "_time:15m", "limit": 100})

    row = response.json()["rows"][0]
    assert "level" not in row


def test_config_normalizes_default_missing_values():
    missing = get_field_mappings(
        Settings(HIKARI_FIELD_MAPPINGS_FILE="missing-field-mappings.json", HIKARI_FIELD_MAPPINGS={"severity": {"canonicalField": "level"}})
    )
    valid = get_field_mappings(
        Settings(HIKARI_FIELD_MAPPINGS_FILE="missing-field-mappings.json", HIKARI_FIELD_MAPPINGS={"severity": {"canonicalField": "level", "defaultMissing": "info"}})
    )
    invalid = get_field_mappings(
        Settings(HIKARI_FIELD_MAPPINGS_FILE="missing-field-mappings.json", HIKARI_FIELD_MAPPINGS={"severity": {"canonicalField": "level", "defaultMissing": "nope"}})
    )

    assert "defaultMissing" not in missing["severity"]
    assert valid["severity"]["defaultMissing"] == "info"
    assert "defaultMissing" not in invalid["severity"]


def test_config_reports_default_missing_info():
    app.dependency_overrides[get_settings] = override_settings_default_missing_info
    with TestClient(app) as test_client:
        response = test_client.get("/api/config")

    assert response.status_code == 200
    assert response.json()["fieldMappings"]["severity"]["defaultMissing"] == "info"


def test_search_maps_missing_level_to_configured_default():
    app.dependency_overrides[get_settings] = override_settings_default_missing_info
    with TestClient(app) as test_client:
        response = test_client.post("/api/search", json={"query": "_time:15m", "limit": 100})

    assert response.status_code == 200
    assert response.json()["rows"][0]["level"] == "info"


def test_hits_facets_and_field_values():
    with TestClient(app) as test_client:
        hits = test_client.post("/api/hits", json={"query": "_time:15m", "step": "1m"})
        facets = test_client.post("/api/facets", json={"query": "_time:15m", "fields": ["service"]})
        values = test_client.get("/api/field-values", params={"query": "_time:15m", "field": "service"})
    assert hits.json()["values"][0]["hits"] == 4
    assert facets.json()["facets"][0]["field"] == "service"
    assert values.json()["values"][0]["value"] == "api"


def test_level_field_values_fold_empty_bucket_into_default_missing_info():
    class LevelValuesClient(FakeVictoriaLogsClient):
        async def query(self, path: str, data: dict):
            self.calls.append((path, data))
            if path == "/select/logsql/field_values" and data["field"] == "level":
                return {"values": [{"value": "info", "hits": 3}, {"value": "", "hits": 5}, {"value": "warn", "hits": 2}]}
            return await super().query(path, data)

    fake = LevelValuesClient()

    def override_fake_client():
        return fake

    from hikari_api.main import client

    app.dependency_overrides[client] = override_fake_client
    app.dependency_overrides[get_settings] = override_settings_default_missing_info
    with TestClient(app) as test_client:
        values = test_client.get("/api/field-values", params={"query": "_time:15m level:info", "field": "level"})
        facets = test_client.post("/api/facets", json={"query": "_time:15m level:info", "fields": ["level"]})

    assert values.json()["values"] == [{"value": "warning", "hits": 2}, {"value": "info", "hits": 8}]
    assert facets.json()["facets"] == [{"field": "level", "values": [{"value": "warning", "hits": 2}, {"value": "info", "hits": 8}]}]
    level_calls = [data for path, data in fake.calls if path == "/select/logsql/field_values" and data["field"] == "level"]
    assert len(level_calls) == 2
    for level_call in level_calls:
        assert "unpack_json" in level_call["query"]
        assert "level:info" not in level_call["query"]
        assert '""' in level_call["query"]
        assert " NOT " in level_call["query"]
        assert '"verbose"' in level_call["query"]
        assert "severity_number:in" in level_call["query"]


def test_level_field_values_keep_debug_sublevels_distinct():
    class LevelValuesClient(FakeVictoriaLogsClient):
        async def query(self, path: str, data: dict):
            self.calls.append((path, data))
            if path == "/select/logsql/field_values" and data["field"] == "level":
                return {
                    "values": [
                        {"value": "debug", "hits": 4},
                        {"value": "verbose", "hits": 7},
                        {"value": "Verbose", "hits": 5},
                        {"value": "trace", "hits": 2},
                        {"value": "", "hits": 3},
                    ]
                }
            return await super().query(path, data)

    fake = LevelValuesClient()

    def override_fake_client():
        return fake

    from hikari_api.main import client

    app.dependency_overrides[client] = override_fake_client
    app.dependency_overrides[get_settings] = override_settings_default_missing_info
    with TestClient(app) as test_client:
        response = test_client.get("/api/field-values", params={"query": "_time:15m level:debug", "field": "level"})
        facets = test_client.post("/api/facets", json={"query": "_time:15m level:debug", "fields": ["level"]})

    expected_values = [
        {"value": "info", "hits": 3},
        {"value": "debug", "hits": 4},
        {"value": "trace", "hits": 2},
        {"value": "verbose", "hits": 12},
    ]
    assert response.json()["values"] == expected_values
    assert facets.json()["facets"] == [{"field": "level", "values": expected_values}]
    level_calls = [data for path, data in fake.calls if path == "/select/logsql/field_values" and data["field"] == "level"]
    assert len(level_calls) == 2
    for level_call in level_calls:
        assert "level:debug" not in level_call["query"]
        assert "severity_number:in" in level_call["query"]
        assert " NOT " in level_call["query"]
        assert 'level:in("trace","TRACE","Trace","verbose","VERBOSE","Verbose")' in level_call["query"]


def test_api_facets_apply_configured_copy_pipes():
    fake = FakeVictoriaLogsClient()

    def override_fake_client() -> FakeVictoriaLogsClient:
        return fake

    from hikari_api.main import client

    app.dependency_overrides[client] = override_fake_client
    with TestClient(app) as test_client:
        response = test_client.post("/api/facets", json={"query": "_time:15m", "fields": ["service", "host"]})
    assert response.status_code == 200
    facets_call = next(data for path, data in fake.calls if path == "/select/logsql/facets")
    assert "copy service_name as service" in facets_call["query"]
    assert "copy host_name as host" in facets_call["query"]
    assert facets_call["field"] == ["service", "host"]


def test_api_facets_normalize_victorialogs_field_name_shape():
    class FieldNameFacetClient(FakeVictoriaLogsClient):
        async def query(self, path: str, data: dict):
            self.calls.append((path, data))
            if path == "/select/logsql/facets":
                return {"facets": [{"field_name": "service", "values": [{"field_value": "api", "hits": 2}]}]}
            return await super().query(path, data)

    fake = FieldNameFacetClient()

    def override_fake_client():
        return fake

    from hikari_api.main import client

    app.dependency_overrides[client] = override_fake_client
    with TestClient(app) as test_client:
        response = test_client.post("/api/facets", json={"query": "_time:15m", "fields": ["service"]})

    assert response.status_code == 200
    assert response.json()["facets"] == [{"field": "service", "values": [{"value": "api", "hits": 2}]}]


def test_config_reports_ai_disabled_without_openai_key():
    app.dependency_overrides[get_settings] = override_settings_without_ai
    with TestClient(app) as test_client:
        response = test_client.get("/api/config")
    assert response.status_code == 200
    assert response.json()["aiEnabled"] is False
    assert response.json()["facetPreviewLimit"] == 10


def test_configured_facet_aliases_copy_host_and_service_names():
    query = with_copy_pipes("_time:15m", TEST_FIELD_MAPPINGS)
    assert "unpack_json" in query
    assert "extract_regexp" in query
    assert "INFO|WARN|WARNING|ERROR" in query
    assert "copy service_name as service" in query
    assert "copy host_name as host" in query
    assert "copy severity_text as level" not in query


def test_level_filters_expand_to_structured_severity_fields():
    query = expand_level_filters('_time:15m level:="error"', TEST_FIELD_MAPPINGS)
    assert "level:in" in query
    assert "severity_text:in" in query
    assert "severity_number:in" in query
    assert "_msg:~" in query
    assert '"Error"' in query
    assert '"17"' in query


def test_level_info_filter_includes_missing_only_when_configured_as_default():
    config = mappings_with_default_missing("info")
    info_query = with_copy_pipes("_time:15m level:info", config)
    error_query = with_copy_pipes("_time:15m level:error", config)

    assert "| filter level:in(" in info_query
    assert '""' in info_query
    assert " NOT " in info_query
    assert '"verbose"' in info_query
    assert "severity_number:in" in info_query
    assert "level:info" not in info_query
    assert "| filter level:in(" not in error_query
    assert '""' not in error_query
    assert "severity_number:in" in error_query


def test_verbose_and_trace_level_filters_remain_exact_values():
    verbose_query = with_copy_pipes('_time:15m level:="verbose"', TEST_FIELD_MAPPINGS)
    trace_query = with_copy_pipes('_time:15m level:trace', TEST_FIELD_MAPPINGS)
    debug_query = with_copy_pipes('_time:15m level:debug', TEST_FIELD_MAPPINGS)

    assert 'level:="verbose"' not in verbose_query
    assert '| filter (level:in("verbose","VERBOSE","Verbose") OR severity_text:in("verbose","VERBOSE","Verbose")' in verbose_query
    assert "SeverityText:in" in verbose_query
    assert "severity_number:in" not in verbose_query
    assert "level:trace" not in trace_query
    assert '| filter (level:in("trace","TRACE","Trace") OR severity_text:in("trace","TRACE","Trace")' in trace_query
    assert "level:debug" not in debug_query
    assert '"debug"' in debug_query
    assert "severity_number:in" in debug_query
    assert " NOT " in debug_query
    assert 'level:in("trace","TRACE","Trace","verbose","VERBOSE","Verbose")' in debug_query


def test_rows_normalize_structured_severity_text_and_number():
    assert normalize_row_aliases({"severity_text": "Error"}, TEST_FIELD_MAPPINGS)["level"] == "error"
    assert normalize_row_aliases({"severity_number": "13"}, TEST_FIELD_MAPPINGS)["level"] == "warning"
    assert normalize_row_aliases({"level": "verbose"}, TEST_FIELD_MAPPINGS)["level"] == "verbose"
    assert normalize_row_aliases({"severity_text": "Verbose"}, TEST_FIELD_MAPPINGS)["level"] == "verbose"
    assert normalize_row_aliases({"level": "debug", "severity_text": "verbose"}, TEST_FIELD_MAPPINGS)["level"] == "verbose"
    assert normalize_row_aliases({"severity_number": "1"}, TEST_FIELD_MAPPINGS)["level"] == "debug"


def test_tail_errors_are_streamed_as_sse_error_events():
    with TestClient(app) as test_client:
        response = test_client.get("/api/tail", params={"query": "_time:5m"})
    assert "event: error" in response.text
    assert "tail failed" in response.text


def test_parse_victorialogs_json_lines_response():
    response = httpx.Response(
        200,
        content=b'{"_msg":"first"}\n{"_msg":"second"}\n',
        headers={"content-type": "application/stream+json"},
    )
    from hikari_api.victorialogs import _parse_response

    parsed = _parse_response(response)
    assert parsed["rows"] == [{"_msg": "first"}, {"_msg": "second"}]


@pytest.mark.anyio
async def test_victorialogs_query_uses_injected_http_client():
    class SharedHttpClient:
        def __init__(self):
            self.calls: list[dict] = []

        async def post(self, url, data=None, headers=None):
            self.calls.append({"url": url, "data": data, "headers": headers})
            return httpx.Response(200, json={"rows": [{"_msg": "ok"}]})

    from hikari_api.victorialogs import VictoriaLogsClient

    shared = SharedHttpClient()
    result = await VictoriaLogsClient(override_settings(), shared).query("/select/logsql/query", {"query": "_time:15m", "limit": 5})

    assert result["rows"][0]["_msg"] == "ok"
    assert shared.calls[0]["url"] == "http://victorialogs/select/logsql/query"
    assert shared.calls[0]["data"] == {"query": "_time:15m", "limit": "5"}


@pytest.mark.anyio
async def test_ai_query_generation(monkeypatch):
    async def fake_post(self, url, headers=None, json=None):
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": json_module.dumps(
                                    {
                                        "query": "_time:15m error",
                                        "query_changed": True,
                                        "explanation": "Finds recent errors.",
                                        "evidence": ["Observed level value error."],
                                    }
                                ),
                            }
                        ],
                    }
                ]
            },
        )

    json_module = json
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    result = await ai.generate_logsql(override_settings(), AiQueryRequest(prompt="recent errors"))
    assert result.query == "_time:15m error"
    assert "errors" in result.explanation
    assert result.evidence == ["Observed level value error."]
    assert result.steps
    assert result.steps[-1].title == "Generated and normalized LogsQL"


@pytest.mark.anyio
async def test_ai_followup_can_keep_current_query(monkeypatch):
    async def fake_post(self, url, headers=None, json=None):
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": json_module.dumps(
                                    {
                                        "query": "_time:1h service:\"worker\" level:error",
                                        "query_changed": False,
                                        "explanation": "The likely fix is to restart the worker after correcting its upstream dependency.",
                                        "evidence": ["Prior rows showed worker errors from the same component."],
                                    }
                                ),
                            }
                        ],
                    }
                ]
            },
        )

    json_module = json
    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    result = await ai.generate_logsql(
        override_settings(),
        AiQueryRequest(
            prompt="likely fix?",
            current_query="_time:15m service:\"worker\" level:error",
            conversation=[{"role": "user", "content": "Why is worker failing?"}],
            incident_context={"query": "_time:15m service:\"worker\" level:error"},
        ),
    )
    assert result.query_changed is False
    assert result.query == "_time:15m service:\"worker\" level:error"
    assert "likely fix" in result.explanation


def test_ai_expands_level_filters_to_observed_variants():
    parsed = {
        "query": '_time:15m service:"billing-api" level:error',
        "explanation": "Finds Billing API errors.",
        "evidence": [],
    }
    discovery = {
        "field_values": {
            "level": [
                {"value": "error", "hits": 10},
                {"value": "ERROR", "hits": 2},
                {"value": "INFO", "hits": 3},
            ]
        }
    }

    result = ai._apply_observed_query_expansions(parsed, discovery)

    assert result["query"] == '_time:15m service:"billing-api" level:in("error", "ERROR")'
    assert result["evidence"] == ["Expanded error level filter to observed values: error, ERROR"]


def test_ai_dedupes_level_filter_expansions_inside_or_groups():
    parsed = {
        "query": '_time:15m service:"billing-api" (level:error OR level:ERROR)',
        "explanation": "Finds Billing API errors.",
        "evidence": [],
    }
    discovery = {
        "field_values": {
            "level": [
                {"value": "error", "hits": 10},
                {"value": "ERROR", "hits": 2},
            ]
        }
    }

    result = ai._apply_observed_query_expansions(parsed, discovery)

    assert result["query"] == '_time:15m service:"billing-api" level:in("error", "ERROR")'


def test_ai_expands_grouped_level_filters_to_observed_variants():
    parsed = {
        "query": '_time:15m service:"billing-api" level:(error OR ERROR)',
        "explanation": "Finds Billing API errors.",
        "evidence": [],
    }
    discovery = {
        "field_values": {
            "level": [
                {"value": "error", "hits": 10},
                {"value": "ERROR", "hits": 2},
            ]
        }
    }

    result = ai._apply_observed_query_expansions(parsed, discovery)

    assert result["query"] == '_time:15m service:"billing-api" level:in("error", "ERROR")'


def test_ai_does_not_expand_level_filter_to_noncanonical_level_field():
    parsed = {
        "query": '_time:15m service:"billing-api" level:error',
        "explanation": "Finds Billing API errors.",
        "evidence": [],
    }
    discovery = {
        "field_values": {
            "level": [],
            "legacy_level": [
                {"value": "Error", "hits": 10},
                {"value": "Fatal", "hits": 2},
                {"value": "Information", "hits": 3},
            ],
        }
    }

    result = ai._apply_observed_query_expansions(parsed, discovery, "why is Billing API failing?")

    assert result["query"] == '_time:15m service:"billing-api" level:error'


def test_ai_uses_requested_level_when_model_mixes_warning_with_errors():
    parsed = {
        "query": '_time:15m service:"billing-api" level:(error OR ERROR OR warn OR WARNING)',
        "explanation": "Finds Billing API errors.",
        "evidence": [],
    }
    discovery = {
        "field_values": {
            "level": [
                {"value": "error", "hits": 10},
                {"value": "ERROR", "hits": 2},
                {"value": "warn", "hits": 3},
                {"value": "WARNING", "hits": 4},
            ]
        }
    }

    result = ai._apply_observed_query_expansions(parsed, discovery, "show me Billing API errors")

    assert result["query"] == '_time:15m service:"billing-api" level:in("error", "ERROR")'


def test_ai_prunes_unrequested_level_in_filters():
    parsed = {
        "query": '_time:15m (level:in("error", "ERROR") or level:in("WARNING", "warn") or _msg:error)',
        "explanation": "Finds Billing API errors.",
        "evidence": [],
    }
    discovery = {
        "field_values": {
            "level": [
                {"value": "error", "hits": 10},
                {"value": "ERROR", "hits": 2},
                {"value": "warn", "hits": 3},
                {"value": "WARNING", "hits": 4},
            ]
        }
    }

    result = ai._apply_observed_query_expansions(parsed, discovery, "show me Billing API errors")

    assert result["query"] == '_time:15m (level:in("error", "ERROR") or _msg:error)'


class FakeMcpVictoriaLogsClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def query(self, path: str, data: dict):
        self.calls.append((path, data))
        if path == "/select/logsql/query":
            return {"rows": [{"_time": "2026-05-01T18:00:00Z", "_msg": "hello", "service": "api"}]}
        if path == "/select/logsql/field_names":
            return {"values": [{"value": "service", "hits": 2}]}
        if path == "/select/logsql/field_values":
            field = data["field"]
            values = {
                "service": [{"value": "api", "hits": 22}],
                "app": [],
                "kubernetes.pod_labels.app.kubernetes.io/name": [],
                "kubernetes.pod_labels.k8s-app": [],
                "kubernetes.pod_labels.app": [],
                "kubernetes.container_name": [{"value": "collector", "hits": 41}],
                "hostname": [{"value": "node-a.internal.example", "hits": 15}],
                "host": [{"value": "node-a.internal.example", "hits": 15}],
                "kubernetes.pod_node_name": [{"value": "node-a.internal.example", "hits": 41717}],
                "kubernetes.node_name": [],
                "level": [{"value": "error", "hits": 263}, {"value": "info", "hits": 193}],
                "kubernetes.pod_namespace": [{"value": "kube-system", "hits": 487}, {"value": "application-staging", "hits": 13}],
                "kubernetes.pod_name": [{"value": "kube-proxy-zbxp5", "hits": 220}],
            }
            return {"values": values.get(field, [{"value": "api", "hits": 2}])}
        if path == "/select/logsql/hits":
            return {"values": [{"time": "2026-05-01T18:00:00Z", "hits": 4}]}
        if path == "/select/logsql/facets":
            return {"facets": [{"field": "service", "values": [{"value": "api", "hits": 2}]}]}
        return {}

    async def stream(self, path: str, data: dict):
        yield json.dumps({"_msg": "tail one", "service": "api"})
        yield json.dumps({"_msg": "tail two", "service": "api"})
        yield json.dumps({"_msg": "tail three", "service": "api"})


@pytest.mark.anyio
async def test_mcp_streamable_http_lists_and_calls_query_tool(monkeypatch):
    monkeypatch.setattr(hikari_mcp, "_settings", override_settings)
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: FakeMcpVictoriaLogsClient())
    transport = ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8000") as http_client:
        async with streamable_http_client(
            "http://localhost:8000/mcp/",
            http_client=http_client,
            terminate_on_close=False,
        ) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()
                tool_names = {tool.name for tool in tools.tools}

                result = await session.call_tool("query_logs", {"query": "_time:15m", "limit": 5})

    assert {
        "get_instructions",
        "query_logs",
        "ai_search",
        "tail_logs",
        "get_fields",
        "get_field_values",
        "get_hits",
        "summarize_window",
        "get_facets",
    } <= tool_names
    assert result.structuredContent["query"] == "_time:15m | limit 5"
    assert result.structuredContent["rows"][0]["service"] == "api"


@pytest.mark.anyio
async def test_mcp_query_logs_normalizes_configured_aliases(monkeypatch):
    class AliasOnlyClient(FakeMcpVictoriaLogsClient):
        async def query(self, path: str, data: dict):
            self.calls.append((path, data))
            return {"rows": [{"_msg": "windows event", "service_name": "windows-event-log", "host_name": "workstation-01"}]}

    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: AliasOnlyClient())
    monkeypatch.setattr(hikari_mcp, "_field_mappings", lambda: TEST_FIELD_MAPPINGS)

    result = await hikari_mcp.query_logs("_time:15m", limit=5)

    assert result["rows"][0]["service"] == "windows-event-log"
    assert result["rows"][0]["host"] == "workstation-01"


@pytest.mark.anyio
async def test_mcp_omits_ai_search_without_openai_key(monkeypatch):
    monkeypatch.setattr(hikari_mcp, "_settings", override_settings_without_ai)
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: FakeMcpVictoriaLogsClient())
    transport = ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8000") as http_client:
        async with streamable_http_client(
            "http://localhost:8000/mcp/",
            http_client=http_client,
            terminate_on_close=False,
        ) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()

    assert "ai_search" not in {tool.name for tool in tools.tools}


@pytest.mark.anyio
async def test_mcp_streamable_http_accepts_no_slash_url(monkeypatch):
    monkeypatch.setattr(hikari_mcp, "_settings", override_settings)
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: FakeMcpVictoriaLogsClient())
    transport = ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8000") as http_client:
        async with streamable_http_client(
            "http://localhost:8000/mcp",
            http_client=http_client,
            terminate_on_close=False,
        ) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = await session.list_tools()

    assert {tool.name for tool in tools.tools} >= {"get_instructions", "query_logs", "summarize_window"}


@pytest.mark.anyio
async def test_mcp_get_instructions_explains_hikari_workflow():
    result = await hikari_mcp.get_instructions()

    assert result["system"] == "Hikari"
    assert result["backend"] == "VictoriaLogs"
    assert "summarize_window" in result["tools"]
    assert "Service" in result["field_glossary"]
    assert any("summarize_window" in step for step in result["workflow"])


@pytest.mark.anyio
async def test_mcp_summarize_window_returns_ui_like_facets(monkeypatch):
    fake = FakeMcpVictoriaLogsClient()
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: fake)
    monkeypatch.setattr(hikari_mcp, "_field_mappings", lambda: TEST_FIELD_MAPPINGS)

    result = await hikari_mcp.summarize_window("_time:15m", limit=25)

    assert result["buckets"] == [{"time": "2026-05-01T18:00:00Z", "hits": 4}]
    assert set(result["facets"]) == {"service", "host", "level", "namespace", "pod"}
    assert result["facets"]["service"]["values"][0] == {"value": "collector", "hits": 41}
    assert result["facets"]["level"]["values"][0]["value"] == "error"
    assert result["facets"]["namespace"]["field"] == "kubernetes.pod_namespace"
    assert result["facets"]["pod"]["field"] == "kubernetes.pod_name"
    called_fields = [data["field"] for path, data in fake.calls if path == "/select/logsql/field_values"]
    assert "service" in called_fields
    assert "kubernetes.container_name" in called_fields
    assert "hostname" in called_fields
    assert "kubernetes.pod_node_name" in called_fields
    assert "kubernetes.pod_namespace" in called_fields
    assert "kubernetes.pod_name" in called_fields


@pytest.mark.anyio
async def test_mcp_summarize_window_uses_host_when_hostname_is_empty(monkeypatch):
    class HostFallbackClient(FakeMcpVictoriaLogsClient):
        async def query(self, path: str, data: dict):
            if path == "/select/logsql/field_values" and data["field"] == "hostname":
                self.calls.append((path, data))
                return {"values": []}
            return await super().query(path, data)

    fake = HostFallbackClient()
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: fake)
    monkeypatch.setattr(hikari_mcp, "_field_mappings", lambda: TEST_FIELD_MAPPINGS)

    result = await hikari_mcp.summarize_window("_time:15m", fields=["hostname"])

    assert result["facets"]["hostname"]["sources"] == [
        "hostname",
        "host",
        "host.name",
        "host_name",
        "MachineName",
        "kubernetes.pod_node_name",
        "kubernetes.node_name",
    ]
    assert result["facets"]["hostname"]["values"][0] == {"value": "node-a.internal.example", "hits": 41717}


@pytest.mark.anyio
async def test_mcp_get_facets_defaults_to_summary_fields(monkeypatch):
    fake = FakeMcpVictoriaLogsClient()
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: fake)
    monkeypatch.setattr(hikari_mcp, "_field_mappings", lambda: TEST_FIELD_MAPPINGS)

    await hikari_mcp.get_facets("_time:15m")

    facets_call = next(data for path, data in fake.calls if path == "/select/logsql/facets")
    assert facets_call["field"] == ["service", "host", "kubernetes.pod_namespace", "kubernetes.pod_name"]
    level_call = next(data for path, data in fake.calls if path == "/select/logsql/field_values" and data["field"] == "level")
    assert "unpack_json" in level_call["query"]


@pytest.mark.anyio
async def test_mcp_get_facets_keeps_explicit_advanced_fields(monkeypatch):
    fake = FakeMcpVictoriaLogsClient()
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: fake)
    monkeypatch.setattr(hikari_mcp, "_field_mappings", lambda: TEST_FIELD_MAPPINGS)

    await hikari_mcp.get_facets("_time:15m", fields=["host", "namespace"])

    facets_call = next(data for path, data in fake.calls if path == "/select/logsql/facets")
    assert facets_call["field"] == ["host", "kubernetes.pod_namespace"]


@pytest.mark.anyio
async def test_mcp_ai_search_generates_and_executes_query(monkeypatch):
    async def fake_generate_logsql(settings, request, vl=None):
        return AiQueryResponse(query="_time:15m service:\"api\"", explanation="Finds API logs.", evidence=["service api observed"])

    monkeypatch.setattr(hikari_mcp, "_settings", override_settings)
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: FakeMcpVictoriaLogsClient())
    monkeypatch.setattr(hikari_mcp, "generate_logsql", fake_generate_logsql)

    result = await hikari_mcp.ai_search("show api logs", limit=3)

    assert result["query"] == '_time:15m service:"api" | limit 3'
    assert result["explanation"] == "Finds API logs."
    assert result["evidence"] == ["service api observed"]
    assert result["rows"][0]["service"] == "api"


@pytest.mark.anyio
async def test_mcp_tail_logs_is_bounded(monkeypatch):
    monkeypatch.setattr(hikari_mcp, "_client", lambda settings=None: FakeMcpVictoriaLogsClient())

    result = await hikari_mcp.tail_logs("_time:5m", duration_seconds=5, max_rows=2)

    assert result["stats"]["count"] == 2
    assert [row["_msg"] for row in result["rows"]] == ["tail one", "tail two"]
