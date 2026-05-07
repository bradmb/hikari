from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from .settings import Settings

FALLBACK_FIELD_MAPPINGS: dict[str, Any] = {
    "defaultFields": ["service", "host", "level", "source", "status", "environment", "client"],
    "aliases": {
        "service": ["service"],
        "host": ["host", "hostname"],
        "hostname": ["hostname", "host"],
        "level": ["level"],
    },
    "facets": [
        {"field": "environment", "label": "Environment"},
        {"field": "service", "label": "Service", "summary": True},
        {"field": "host", "label": "Host", "summary": True},
        {"field": "level", "label": "Level", "summary": True},
        {"field": "source", "label": "Source"},
    ],
}


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _resolve_config_path(path: str) -> Path | None:
    if not path:
        return None
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    bases = [
        Path.cwd(),
        Path(__file__).resolve().parents[1],
        Path(__file__).resolve().parents[2],
    ]
    for base in bases:
        resolved = base / candidate
        if resolved.exists():
            return resolved
    return Path.cwd() / candidate


def _load_file(path: str) -> dict[str, Any]:
    resolved = _resolve_config_path(path)
    if not resolved or not resolved.exists():
        return {}
    with resolved.open("r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    if not isinstance(parsed, dict):
        raise ValueError("Field mappings config must be a JSON object")
    return parsed


def _normalize(config: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(FALLBACK_FIELD_MAPPINGS)
    if "defaultFields" in config:
        normalized["defaultFields"] = _string_list(config.get("defaultFields")) or normalized["defaultFields"]
    if isinstance(config.get("aliases"), dict):
        aliases: dict[str, list[str]] = {}
        for field, values in config["aliases"].items():
            clean = _string_list(values)
            if clean:
                aliases[str(field).strip()] = clean
        normalized["aliases"] = aliases or normalized["aliases"]
    if isinstance(config.get("facets"), list):
        facets = []
        for item in config["facets"]:
            if not isinstance(item, dict):
                continue
            field = str(item.get("field", "")).strip()
            if not field:
                continue
            facets.append(
                {
                    "field": field,
                    "key": str(item.get("key") or field).strip(),
                    "label": str(item.get("label") or field).strip(),
                    "summary": bool(item.get("summary", False)),
                }
            )
        if facets:
            normalized["facets"] = facets
    return normalized


def _merge_config(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in override.items():
        if key == "aliases" and isinstance(value, dict) and isinstance(merged.get("aliases"), dict):
            merged["aliases"] = {**merged["aliases"], **value}
        else:
            merged[key] = value
    return merged


def get_field_mappings(settings: Settings) -> dict[str, Any]:
    config = _load_file(settings.field_mappings_file)
    if settings.field_mappings:
        config = _merge_config(config, settings.field_mappings)
    return _normalize(config)


def aliases_for(config: dict[str, Any], field: str) -> list[str]:
    aliases = config.get("aliases", {})
    if isinstance(aliases, dict):
        values = _string_list(aliases.get(field))
        if values:
            return values
    return [field]


def copy_pipes_for(config: dict[str, Any]) -> list[str]:
    aliases = config.get("aliases", {})
    if not isinstance(aliases, dict):
        return []

    pipes: list[str] = []
    for target, values in aliases.items():
        target_field = str(target).strip()
        if not target_field:
            continue
        for source in _string_list(values):
            if source == target_field:
                continue
            pipes.append(f"copy {source} as {target_field}")
    return list(dict.fromkeys(pipes))


def with_copy_pipes(query: str, config: dict[str, Any]) -> str:
    clean_query = query.strip()
    if not clean_query:
        clean_query = "_time:15m"
    existing = clean_query.lower()
    pipes = [pipe for pipe in copy_pipes_for(config) if f"| {pipe}".lower() not in existing]
    if not pipes:
        return clean_query
    return f"{clean_query} | {' | '.join(pipes)}"


def summary_facets(config: dict[str, Any]) -> list[dict[str, Any]]:
    return [facet for facet in config.get("facets", []) if facet.get("summary")]
