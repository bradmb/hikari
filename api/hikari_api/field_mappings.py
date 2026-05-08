from __future__ import annotations

import json
import re
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
    "derivedFields": {},
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
    if isinstance(config.get("derivedFields"), dict):
        derived_fields: dict[str, list[dict[str, Any]]] = {}
        for field, rules in config["derivedFields"].items():
            if not isinstance(rules, list):
                continue
            clean_rules = []
            for rule in rules:
                if not isinstance(rule, dict):
                    continue
                rule_type = str(rule.get("type", "")).strip()
                sources = _string_list(rule.get("sources")) or _string_list([rule.get("source")])
                if not rule_type or not sources:
                    continue
                clean_rule: dict[str, Any] = {"type": rule_type, "sources": sources}
                if rule.get("path"):
                    clean_rule["path"] = str(rule["path"]).strip()
                if rule.get("pattern"):
                    clean_rule["pattern"] = str(rule["pattern"])
                if rule.get("queryPattern"):
                    clean_rule["queryPattern"] = str(rule["queryPattern"])
                if rule.get("flags"):
                    clean_rule["flags"] = str(rule["flags"]).strip()
                if rule.get("value") is not None:
                    clean_rule["value"] = str(rule["value"]).strip()
                if clean_rule.get("path") or (clean_rule.get("pattern") and clean_rule.get("value")):
                    clean_rules.append(clean_rule)
            if clean_rules:
                derived_fields[str(field).strip()] = clean_rules
        normalized["derivedFields"] = derived_fields
    return normalized


def _merge_config(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in override.items():
        if key in {"aliases", "derivedFields"} and isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def get_field_mappings(settings: Settings) -> dict[str, Any]:
    """Load, merge, and normalize the configured canonical field/facet mapping."""
    config = _load_file(settings.field_mappings_file)
    if settings.field_mappings:
        config = _merge_config(config, settings.field_mappings)
    return _normalize(config)


def aliases_for(config: dict[str, Any], field: str) -> list[str]:
    """Return configured source fields for a canonical field, preserving the field itself as fallback."""
    aliases = config.get("aliases", {})
    if isinstance(aliases, dict):
        values = _string_list(aliases.get(field))
        if values:
            return values
    return [field]


def copy_pipes_for(config: dict[str, Any]) -> list[str]:
    """Build VictoriaLogs copy pipes that populate canonical fields from configured aliases."""
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
    """Append missing copy pipes so downstream queries and rows expose canonical fields."""
    clean_query = query.strip()
    if not clean_query:
        clean_query = "_time:15m"
    existing = clean_query.lower()
    pipes = [pipe for pipe in copy_pipes_for(config) if f"| {pipe}".lower() not in existing]
    if not pipes:
        return clean_query
    return f"{clean_query} | {' | '.join(pipes)}"


def _row_value(row: dict[str, Any], field: str) -> Any:
    value = row.get(field)
    if value is not None and str(value) != "":
        return value
    return None


def _canonical_level(value: Any) -> str | None:
    normalized = str(value).strip().lower()
    if normalized in {"fatal", "critical", "err", "error"}:
        return "error"
    if normalized in {"warn", "warning"}:
        return "warning"
    if normalized in {"info", "information"}:
        return "info"
    if normalized in {"debug", "trace", "verbose"}:
        return normalized
    return normalized or None


def _json_path_value(value: Any, path: str) -> Any:
    if isinstance(value, str):
        raw = value.strip()
        if not raw.startswith("{"):
            return None
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return None
    current = value
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _derive_field(row: dict[str, Any], config: dict[str, Any], field: str) -> str | None:
    rules = config.get("derivedFields", {}).get(field, [])
    if not isinstance(rules, list):
        return None
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        rule_type = rule.get("type")
        sources = _string_list(rule.get("sources"))
        for source in sources:
            value = _row_value(row, source)
            if value is None:
                continue
            if rule_type == "json":
                derived = _json_path_value(value, str(rule.get("path", "")))
                if derived is not None:
                    return _canonical_level(derived) if field == "level" else str(derived)
            if rule_type == "regex" and rule.get("pattern") and rule.get("value"):
                flags = re.IGNORECASE if "i" in str(rule.get("flags", "")) else 0
                if re.search(str(rule["pattern"]), str(value), flags=flags):
                    return _canonical_level(rule["value"]) if field == "level" else str(rule["value"])
    return None


def _level_from_message(row: dict[str, Any], config: dict[str, Any]) -> str | None:
    return _derive_field(row, config, "level")


def normalize_row_aliases(row: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Populate missing canonical row fields from their configured alias sources."""
    normalized = dict(row)
    aliases = config.get("aliases", {})
    if not isinstance(aliases, dict):
        return normalized

    for target, values in aliases.items():
        target_field = str(target).strip()
        if not target_field or _row_value(normalized, target_field) is not None:
            continue
        for source in _string_list(values):
            value = _row_value(normalized, source)
            if value is not None:
                normalized[target_field] = value
                break
    if _row_value(normalized, "level") is None:
        inferred_level = _level_from_message(normalized, config)
        if inferred_level:
            normalized["level"] = inferred_level
    return normalized


def normalize_rows_aliases(rows: list[Any], config: dict[str, Any]) -> list[Any]:
    return [normalize_row_aliases(row, config) if isinstance(row, dict) else row for row in rows]


def summary_facets(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Return facets intended for compact UI/MCP window summaries."""
    return [facet for facet in config.get("facets", []) if facet.get("summary")]
