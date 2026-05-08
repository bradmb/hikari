from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from .settings import Settings

SEVERITY_CANONICALS: tuple[str, ...] = ("error", "warning", "info", "debug")

FALLBACK_FIELD_MAPPINGS: dict[str, Any] = {
    "defaultFields": ["service", "host", "level", "source", "status", "environment", "client"],
    "aliases": {
        "service": ["service"],
        "host": ["host", "hostname"],
        "hostname": ["hostname", "host"],
        "level": ["level", "severity_text", "SeverityText", "severity", "Severity", "severityText", "level_name", "levelName"],
    },
    "severity": {
        "canonicalField": "level",
        "defaultMissing": "info",
        "textFields": ["level", "severity_text", "SeverityText", "severity", "Severity", "severityText", "level_name", "levelName"],
        "numberFields": ["severity_number", "SeverityNumber", "severityNumber"],
        "values": {
            "error": ["error", "err", "fatal", "critical", "crit", "alert", "emerg", "e", "f"],
            "warning": ["warning", "warn", "notice", "w"],
            "info": ["info", "information", "informational", "i"],
            "debug": ["debug", "trace", "verbose"],
        },
        "messageFilters": {
            "error": [
                "_msg:~'\"level\"[[:space:]]*:[[:space:]]*\"(error|err|fatal|critical|crit|alert|emerg)'",
                "_msg:~'[[](emerg|alert|crit|critical|error|err)[]]'",
                "_msg:~'^E[0-9]{4}'",
                "_msg:~'^F[0-9]{4}'",
            ],
            "warning": [
                "_msg:~'\"level\"[[:space:]]*:[[:space:]]*\"(warn|warning|notice)'",
                "_msg:~'[[](warn|warning|notice)[]]'",
                "_msg:~'^W[0-9]{4}'",
            ],
            "info": [
                "_msg:~'\"level\"[[:space:]]*:[[:space:]]*\"(info|information|informational)'",
                "_msg:~'^I[0-9]{4}'",
            ],
            "debug": [
                "_msg:~'\"level\"[[:space:]]*:[[:space:]]*\"(debug|trace|verbose)'",
            ],
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
    if isinstance(config.get("severity"), dict):
        severity = deepcopy(normalized["severity"])
        override = config["severity"]
        canonical = str(override.get("canonicalField") or severity["canonicalField"]).strip()
        if canonical:
            severity["canonicalField"] = canonical
        if "defaultMissing" in override:
            default_missing = override.get("defaultMissing")
            if default_missing is None:
                severity.pop("defaultMissing", None)
            else:
                default_missing = str(default_missing).strip().lower()
                if default_missing in SEVERITY_CANONICALS:
                    severity["defaultMissing"] = default_missing
                else:
                    severity.pop("defaultMissing", None)
        else:
            severity.pop("defaultMissing", None)
        for key in ("textFields", "numberFields"):
            values = _string_list(override.get(key))
            if values:
                severity[key] = values
        if isinstance(override.get("values"), dict):
            values_config: dict[str, list[str]] = {}
            for canonical_name in SEVERITY_CANONICALS:
                values = _string_list(override["values"].get(canonical_name))
                values_config[canonical_name] = values or severity["values"].get(canonical_name, [])
            severity["values"] = values_config
        if isinstance(override.get("messageFilters"), dict):
            filters_config: dict[str, list[str]] = {}
            current_filters = severity.get("messageFilters", {})
            if not isinstance(current_filters, dict):
                current_filters = {}
            for canonical_name in SEVERITY_CANONICALS:
                values = _string_list(override["messageFilters"].get(canonical_name))
                filters_config[canonical_name] = values or _string_list(current_filters.get(canonical_name))
            severity["messageFilters"] = filters_config
        values = _string_list(override.get("extractPipes"))
        if values:
            severity["extractPipes"] = values
        if isinstance(override.get("numberRanges"), dict):
            ranges = dict(severity["numberRanges"])
            for canonical_name in SEVERITY_CANONICALS:
                value = override["numberRanges"].get(canonical_name)
                if isinstance(value, list) and len(value) == 2:
                    try:
                        ranges[canonical_name] = [int(value[0]), int(value[1])]
                    except (TypeError, ValueError):
                        pass
            severity["numberRanges"] = ranges
        normalized["severity"] = severity

    severity = normalized["severity"]
    canonical_field = str(severity["canonicalField"])
    text_fields = _string_list(severity.get("textFields"))
    if text_fields:
        aliases = normalized.get("aliases", {})
        if isinstance(aliases, dict):
            configured = _string_list(aliases.get(canonical_field))
            aliases[canonical_field] = list(dict.fromkeys([*configured, *text_fields]))
            normalized["aliases"] = aliases
    return normalized


def _merge_config(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in override.items():
        if key == "aliases" and isinstance(value, dict) and isinstance(merged.get(key), dict):
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


def severity_config(config: dict[str, Any]) -> dict[str, Any]:
    severity = config.get("severity")
    return severity if isinstance(severity, dict) else FALLBACK_FIELD_MAPPINGS["severity"]


def severity_default_missing(config: dict[str, Any]) -> str | None:
    value = severity_config(config).get("defaultMissing")
    if value is None:
        return None
    canonical = str(value).strip().lower()
    return canonical if canonical in SEVERITY_CANONICALS else None


def canonical_severity(value: Any, config: dict[str, Any]) -> str | None:
    """Map structured severity text values to Hikari's canonical level names."""
    text = str(value).strip()
    if not text:
        return None
    lower = text.lower()
    values = severity_config(config).get("values", {})
    if not isinstance(values, dict):
        values = {}
    for canonical in SEVERITY_CANONICALS:
        if lower in {item.lower() for item in _string_list(values.get(canonical))}:
            return canonical
    return None


def canonical_severity_number(value: Any, config: dict[str, Any]) -> str | None:
    """Map OpenTelemetry severity_number values to Hikari's canonical level names."""
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    ranges = severity_config(config).get("numberRanges", {})
    if not isinstance(ranges, dict):
        ranges = {}
    for canonical in SEVERITY_CANONICALS:
        value_range = ranges.get(canonical)
        if isinstance(value_range, list) and len(value_range) == 2:
            try:
                start, end = int(value_range[0]), int(value_range[1])
            except (TypeError, ValueError):
                continue
            if start <= number <= end:
                return canonical
    return None


def severity_values_for(config: dict[str, Any], canonical: str) -> list[str]:
    values = severity_config(config).get("values", {})
    if not isinstance(values, dict):
        values = {}
    return _string_list(values.get(canonical))


def severity_query_values_for(config: dict[str, Any], canonical: str) -> list[str]:
    """Return common case variants for exact structured severity field matching."""
    values: list[str] = []
    for value in severity_values_for(config, canonical):
        values.extend([value, value.lower(), value.upper(), value[:1].upper() + value[1:].lower()])
    return list(dict.fromkeys(values))


def severity_filter_values_for(config: dict[str, Any], canonical: str, *, include_missing: bool = False) -> list[str]:
    """Return structured severity values for LogsQL field filtering."""
    values = severity_query_values_for(config, canonical)
    if include_missing:
        values.append("")
    return list(dict.fromkeys(values))


def severity_numbers_for(config: dict[str, Any], canonical: str) -> list[str]:
    ranges = severity_config(config).get("numberRanges", {})
    value_range = ranges.get(canonical) if isinstance(ranges, dict) else None
    if not isinstance(value_range, list) or len(value_range) != 2:
        return []
    try:
        start, end = int(value_range[0]), int(value_range[1])
    except (TypeError, ValueError):
        return []
    return [str(value) for value in range(start, end + 1)]


def severity_message_filters_for(config: dict[str, Any], canonical: str) -> list[str]:
    filters = severity_config(config).get("messageFilters", {})
    if not isinstance(filters, dict):
        return []
    return _string_list(filters.get(canonical))


def severity_extract_pipes(config: dict[str, Any]) -> list[str]:
    return _string_list(severity_config(config).get("extractPipes"))


def _field_filter(field: str, values: list[str], *, include_empty: bool = False) -> str:
    unique = list(dict.fromkeys(value for value in values if value or include_empty))
    if not unique:
        return ""
    quoted = ",".join(json.dumps(value) for value in unique)
    return f"{field}:in({quoted})"


def severity_filter_clause(config: dict[str, Any], canonical: str) -> str:
    """Build a LogsQL clause that matches a canonical severity across structured fields."""
    text_values = severity_filter_values_for(config, canonical)
    number_values = severity_numbers_for(config, canonical)
    severity = severity_config(config)
    clauses = [
        _field_filter(field, text_values)
        for field in _string_list(severity.get("textFields"))
    ]
    clauses.extend(
        _field_filter(field, number_values)
        for field in _string_list(severity.get("numberFields"))
    )
    clauses.extend(severity_message_filters_for(config, canonical))
    clauses = [clause for clause in clauses if clause]
    if not clauses:
        return ""
    return f"({' OR '.join(clauses)})"


def default_missing_level_filter_clause(config: dict[str, Any], canonical: str) -> str:
    """Build the post-pipe level filter used when missing levels map to a default canonical."""
    if canonical != severity_default_missing(config):
        return ""
    field = str(severity_config(config).get("canonicalField") or "level")
    return _field_filter(field, severity_filter_values_for(config, canonical, include_missing=True), include_empty=True)


def _split_query_pipes(query: str) -> tuple[str, str]:
    quote: str | None = None
    for index, ch in enumerate(query):
        if ch in {"'", '"'} and (index == 0 or query[index - 1] != "\\"):
            quote = None if quote == ch else ch if quote is None else quote
        elif ch == "|" and quote is None:
            return query[:index].strip(), query[index:].strip()
    return query.strip(), ""


def _parse_level_values(value: str) -> list[str]:
    values = [item.strip() for item in re.split(r"\s*,\s*|\s+OR\s+", value, flags=re.IGNORECASE)]
    return [item.strip().strip('"').strip("'") for item in values if item.strip()]


def expand_level_filters(query: str, config: dict[str, Any]) -> str:
    """Replace user-facing level filters with structured VictoriaLogs severity clauses."""
    head, pipes = _split_query_pipes(query)
    if not head:
        return query

    canonical_field = re.escape(str(severity_config(config).get("canonicalField") or "level"))
    in_pattern = re.compile(rf"(?<![\w.]){canonical_field}:in\((?P<values>[^)]*)\)", re.IGNORECASE)
    group_pattern = re.compile(rf"(?<![\w.]){canonical_field}:\((?P<values>[^)]*)\)", re.IGNORECASE)
    value_pattern = re.compile(
        rf"(?<![\w.]){canonical_field}:(?:=\"(?P<exact>[^\"]+)\"|\"(?P<quoted>[^\"]+)\"|(?P<word>[A-Za-z][\w-]*))",
        re.IGNORECASE,
    )

    def replace_values(match: re.Match[str]) -> str:
        clauses = [
            severity_filter_clause(config, canonical)
            for canonical in {canonical_severity(value, config) for value in _parse_level_values(match.group("values"))}
            if canonical
        ]
        clauses = [clause for clause in clauses if clause]
        if not clauses:
            return match.group(0)
        return f"({' OR '.join(clauses)})" if len(clauses) > 1 else clauses[0]

    def replace_value(match: re.Match[str]) -> str:
        value = match.group("exact") or match.group("quoted") or match.group("word") or ""
        canonical = canonical_severity(value, config)
        return severity_filter_clause(config, canonical) if canonical else match.group(0)

    head = in_pattern.sub(replace_values, head)
    head = group_pattern.sub(replace_values, head)
    head = value_pattern.sub(replace_value, head)
    return f"{head} {pipes}".strip() if pipes else head


def _remove_simple_default_missing_filter(query: str, config: dict[str, Any]) -> tuple[str, str]:
    """Move a simple default-missing level filter to a post-extraction pipe filter.

    This intentionally handles the common UI/API form, such as ``level:info`` or
    ``level:in("info","INFO")``. Mixed severity OR filters stay on the existing
    structured expansion path so they do not accidentally become an AND filter.
    """
    default_missing = severity_default_missing(config)
    if not default_missing:
        return query, ""

    head, pipes = _split_query_pipes(query)
    if not head:
        return query, ""

    canonical_field = re.escape(str(severity_config(config).get("canonicalField") or "level"))
    filters: list[str] = []

    def all_default(values: str) -> bool:
        parsed = _parse_level_values(values)
        return bool(parsed) and all(canonical_severity(value, config) == default_missing for value in parsed)

    def is_negated(match: re.Match[str]) -> bool:
        return head[: match.start()].rstrip().lower().endswith("not")

    in_pattern = re.compile(rf"(?<![\w.]){canonical_field}:in\((?P<values>[^)]*)\)", re.IGNORECASE)
    group_pattern = re.compile(rf"(?<![\w.]){canonical_field}:\((?P<values>[^)]*)\)", re.IGNORECASE)
    value_pattern = re.compile(
        rf"(?<![\w.]){canonical_field}:(?:=\"(?P<exact>[^\"]+)\"|\"(?P<quoted>[^\"]+)\"|(?P<word>[A-Za-z][\w-]*))",
        re.IGNORECASE,
    )

    def replace_values(match: re.Match[str]) -> str:
        if is_negated(match):
            return match.group(0)
        if not all_default(match.group("values")):
            return match.group(0)
        filters.append(default_missing)
        return " "

    def replace_value(match: re.Match[str]) -> str:
        if is_negated(match):
            return match.group(0)
        value = match.group("exact") or match.group("quoted") or match.group("word") or ""
        if canonical_severity(value, config) != default_missing:
            return match.group(0)
        filters.append(default_missing)
        return " "

    head = in_pattern.sub(replace_values, head)
    head = group_pattern.sub(replace_values, head)
    head = value_pattern.sub(replace_value, head)
    if not filters:
        return query, ""
    head = re.sub(r"\s+", " ", head).strip() or "_time:15m"
    post_filter = default_missing_level_filter_clause(config, default_missing)
    return (f"{head} {pipes}".strip() if pipes else head), post_filter


def with_severity_filter(query: str, canonical: str, config: dict[str, Any]) -> str:
    """Add a canonical severity filter before any LogsQL pipes."""
    clause = severity_filter_clause(config, canonical)
    if not clause:
        return query
    head, pipes = _split_query_pipes(query.strip() or "_time:15m")
    filtered = f"{head} {clause}".strip()
    return f"{filtered} {pipes}".strip() if pipes else filtered


def copy_pipes_for(config: dict[str, Any]) -> list[str]:
    """Build VictoriaLogs copy pipes that populate canonical fields from configured aliases."""
    aliases = config.get("aliases", {})
    if not isinstance(aliases, dict):
        return []

    severity_field = str(severity_config(config).get("canonicalField") or "level")
    pipes: list[str] = []
    for target, values in aliases.items():
        target_field = str(target).strip()
        if not target_field:
            continue
        if target_field == severity_field:
            continue
        for source in _string_list(values):
            if source == target_field:
                continue
            pipes.append(f"copy {source} as {target_field}")
    return list(dict.fromkeys(pipes))


def with_copy_pipes(query: str, config: dict[str, Any]) -> str:
    """Expand canonical filters and append copy pipes so queries expose canonical fields."""
    clean_query = query.strip()
    if not clean_query:
        clean_query = "_time:15m"
    clean_query, default_missing_filter = _remove_simple_default_missing_filter(clean_query, config)
    clean_query = expand_level_filters(clean_query, config)
    existing = clean_query.lower()
    pipes = [
        pipe
        for pipe in [*severity_extract_pipes(config), *copy_pipes_for(config)]
        if f"| {pipe}".lower() not in existing
    ]
    if default_missing_filter and f"| filter {default_missing_filter}".lower() not in existing:
        pipes.append(f"filter {default_missing_filter}")
    if not pipes:
        return clean_query
    return f"{clean_query} | {' | '.join(pipes)}"


def _row_value(row: dict[str, Any], field: str) -> Any:
    value = row.get(field)
    if value is not None and str(value) != "":
        return value
    return None


def normalize_row_aliases(row: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    """Populate missing canonical row fields from their configured alias sources."""
    normalized = dict(row)
    severity = severity_config(config)
    canonical_field = str(severity.get("canonicalField") or "level")
    for source in _string_list(severity.get("textFields")):
        canonical = canonical_severity(_row_value(normalized, source), config)
        if canonical:
            normalized[canonical_field] = canonical
            break
    if _row_value(normalized, canonical_field) is None:
        for source in _string_list(severity.get("numberFields")):
            canonical = canonical_severity_number(_row_value(normalized, source), config)
            if canonical:
                normalized[canonical_field] = canonical
                break
    if _row_value(normalized, canonical_field) is None:
        default_missing = severity_default_missing(config)
        if default_missing:
            normalized[canonical_field] = default_missing

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
    return normalized


def normalize_rows_aliases(rows: list[Any], config: dict[str, Any]) -> list[Any]:
    return [normalize_row_aliases(row, config) if isinstance(row, dict) else row for row in rows]


def summary_facets(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Return facets intended for compact UI/MCP window summaries."""
    return [facet for facet in config.get("facets", []) if facet.get("summary")]
