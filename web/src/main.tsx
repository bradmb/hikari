import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  Download,
  Filter,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
  X
} from "lucide-react";
import { generateQuery, getFieldValues, getFields, getHits, searchLogs, tailUrl, type AiStep, type LogRow, type ValueHit } from "./api";
import "./styles.css";

const defaultFields = [
  "environment",
  "service",
  "host",
  "hostname",
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
  "kubernetes.pod_labels.app"
];

const hostFields = [
  "host",
  "hostname",
  "kubernetes.pod_node_name",
  "kubernetes.node_name"
];

const serviceFields = [
  "service",
  "app",
  "kubernetes.pod_labels.app.kubernetes.io/name",
  "kubernetes.pod_labels.k8s-app",
  "kubernetes.pod_labels.app",
  "kubernetes.pod_labels.app.kubernetes.io/component",
  "kubernetes.container_name",
  "source"
];

const priorityFilters = [
  { field: "environment", label: "Environment" },
  { field: "service", label: "Service" },
  { field: "host", label: "Host" },
  { field: "hostname", label: "Hostname" },
  { field: "level", label: "Level" },
  { field: "source", label: "Source" },
  { field: "kubernetes.pod_namespace", label: "Namespace" },
  { field: "kubernetes.pod_name", label: "Pod" }
];

const aiProgressTemplate: AiStep[] = [
  {
    title: "Preparing investigation",
    status: "pending",
    detail: "Reading your prompt and the current LogsQL query."
  },
  {
    title: "Scanning field values",
    status: "pending",
    tool: "/select/logsql/field_values",
    detail: "Looking across service, host, environment, level, source, and Kubernetes fields."
  },
  {
    title: "Sampling log rows",
    status: "pending",
    tool: "/select/logsql/query",
    detail: "Checking recent events to find how the thing you named is represented in real logs."
  },
  {
    title: "Asking AI to map the data",
    status: "pending",
    tool: "OpenAI Responses API",
    detail: "Turning observed values into an editable LogsQL query."
  },
  {
    title: "Testing and normalizing query",
    status: "pending",
    detail: "Expanding level variants and cleaning up the final query."
  }
];

const sampleRows: LogRow[] = [
  {
    _time: "2026-05-01T18:14:12Z",
    level: "Error",
    service: "api",
    host: "eks-api-74b7",
    status: 500,
    _msg: "Request failed while loading customer document metadata"
  },
  {
    _time: "2026-05-01T18:13:45Z",
    level: "Information",
    service: "worker",
    host: "eks-worker-1d2f",
    status: 200,
    _msg: "Completed nightly disclosure package refresh"
  },
  {
    _time: "2026-05-01T18:12:03Z",
    level: "Warning",
    service: "portal",
    host: "eks-portal-8a11",
    status: 429,
    _msg: "Client throttled by downstream LOS API"
  }
];

type AppliedFilter = {
  field: string;
  value: string;
  token: string;
};

type ViewMode = "welcome" | "answer" | "explore";

const defaultLogQuery = "_time:15m";
const logQueryParam = "q";
const selectedEventParam = "event";
const selectedEventStoragePrefix = "hikari:selected-event:";

function modeFromPath(pathname: string): ViewMode {
  return pathname === "/browse" ? "explore" : "welcome";
}

function selectedEventIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get(selectedEventParam);
}

function logQueryFromUrl(): string {
  return new URLSearchParams(window.location.search).get(logQueryParam)?.trim() || defaultLogQuery;
}

function stableLogJson(row: LogRow): string {
  const sorted: LogRow = {};
  Object.keys(row).sort().forEach((key) => {
    sorted[key] = row[key];
  });
  return JSON.stringify(sorted);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function logEventId(row: LogRow): string {
  return hashText([
    timeValue(row),
    levelValue(row),
    serviceValue(row),
    hostValue(row),
    message(row),
    stableLogJson(row)
  ].join("|"));
}

function storedLogEvent(id: string): LogRow | null {
  try {
    const value = window.localStorage.getItem(`${selectedEventStoragePrefix}${id}`);
    return value ? JSON.parse(value) as LogRow : null;
  } catch {
    return null;
  }
}

function storeLogEvent(row: LogRow): string {
  const id = logEventId(row);
  try {
    window.localStorage.setItem(`${selectedEventStoragePrefix}${id}`, stableLogJson(row));
  } catch {
    // URL state still works for rows that remain in memory.
  }
  return id;
}

function rowForEventId(id: string, rows: LogRow[]): LogRow | null {
  return rows.find((row) => logEventId(row) === id) ?? storedLogEvent(id);
}

function buildAppUrl(mode: ViewMode, eventId?: string | null, logQuery?: string | null): string {
  const params = new URLSearchParams(window.location.search);
  const cleanQuery = (logQuery ?? params.get(logQueryParam) ?? "").trim();
  if (mode === "explore" && cleanQuery && cleanQuery !== defaultLogQuery) {
    params.set(logQueryParam, cleanQuery);
  } else {
    params.delete(logQueryParam);
  }
  if (mode === "explore" && eventId) {
    params.set(selectedEventParam, eventId);
  } else {
    params.delete(selectedEventParam);
  }
  const path = mode === "explore" ? "/browse" : "/";
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

type Suggestion = {
  text: string;
  tone: "error" | "warning" | "info" | "neutral";
};

const fallbackSuggestions: Suggestion[] = [
  { text: "Show me errors in the last hour", tone: "error" },
  { text: "Slow requests from production", tone: "warning" },
  { text: "Authentication failures", tone: "error" },
  { text: "What changed in the last 15 minutes?", tone: "neutral" }
];

function topByCount<T>(items: T[], getKey: (item: T) => string | undefined): Array<[string, number]> {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    const key = getKey(item);
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

type Mood = {
  hue: number;
  saturation: number;
  intensity: number;
  label: string;
};

function deriveMood(rows: LogRow[]): Mood {
  if (rows.length < 5) {
    return { hue: 188, saturation: 48, intensity: 0.35, label: "calm" };
  }
  const total = rows.length;
  const counts = { error: 0, warning: 0, info: 0, debug: 0, other: 0 };
  rows.forEach((row) => {
    counts[severityKey(levelValue(row))] += 1;
  });
  const errorRate = counts.error / total;
  const warningRate = counts.warning / total;

  const cutoff = Date.now() - 2 * 60 * 1000;
  const recentErrors = rows.filter((row) => {
    const t = rowTimestamp(row);
    return !Number.isNaN(t) && t >= cutoff && severityKey(levelValue(row)) === "error";
  }).length;

  function round(v: number) {
    return Math.round(v * 20) / 20;
  }

  if (errorRate > 0.5 || recentErrors >= 5) {
    return {
      hue: 4,
      saturation: 78,
      intensity: round(Math.min(0.95, 0.55 + errorRate * 0.6)),
      label: "alert"
    };
  }
  if (errorRate > 0.2) {
    return { hue: 22, saturation: 75, intensity: 0.62, label: "elevated" };
  }
  if (warningRate > 0.3 || errorRate > 0.05) {
    return { hue: 44, saturation: 72, intensity: 0.5, label: "active" };
  }
  if (warningRate > 0.05) {
    return { hue: 198, saturation: 55, intensity: 0.4, label: "steady" };
  }
  return { hue: 165, saturation: 50, intensity: 0.36, label: "calm" };
}

function buildTrendingSuggestions(rows: LogRow[]): Suggestion[] {
  if (rows.length < 5) return fallbackSuggestions;

  const errorRows = rows.filter((row) => severityKey(levelValue(row)) === "error");
  const warningRows = rows.filter((row) => severityKey(levelValue(row)) === "warning");
  const out: Suggestion[] = [];
  const seen = new Set<string>();

  function add(suggestion: Suggestion) {
    const key = suggestion.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(suggestion);
  }

  const topErrorService = topByCount(errorRows, (row) => serviceValue(row) || undefined)[0];
  if (topErrorService && topErrorService[1] >= 3) {
    add({ text: `Why is ${topErrorService[0]} failing?`, tone: "error" });
  }

  const recentCutoff = Date.now() - 5 * 60 * 1000;
  const recentErrors = errorRows.filter((row) => {
    const t = rowTimestamp(row);
    return !Number.isNaN(t) && t >= recentCutoff;
  }).length;
  if (recentErrors >= 4) {
    add({ text: `What spiked in the last 5 minutes?`, tone: "error" });
  }

  const topErrorEnv = topByCount(errorRows, (row) => envValue(row) || undefined)[0];
  if (topErrorEnv && topErrorEnv[1] >= 3 && (!topErrorService || topErrorEnv[0] !== topErrorService[0])) {
    add({ text: `Errors in ${topErrorEnv[0]}`, tone: "error" });
  }

  const topWarnService = topByCount(warningRows, (row) => serviceValue(row) || undefined)[0];
  if (topWarnService && topWarnService[1] >= 3) {
    const skip = topErrorService && topWarnService[0] === topErrorService[0];
    if (!skip) add({ text: `Warnings from ${topWarnService[0]}`, tone: "warning" });
  }

  const badStatus = topByCount(rows, (row) => {
    const s = asText(row.status);
    return s && !s.startsWith("2") && !s.startsWith("1") ? s : undefined;
  })[0];
  if (badStatus && badStatus[1] >= 3) {
    add({ text: `Show me ${badStatus[0]} responses`, tone: "warning" });
  }

  const errorPattern = topByCount(errorRows, (row) => {
    const msg = message(row);
    const head = msg.split(/[\s,;:]+/).slice(0, 4).join(" ").trim();
    return head.length >= 8 ? head : undefined;
  })[0];
  if (errorPattern && errorPattern[1] >= 3 && out.length < 4) {
    add({ text: `Investigate "${errorPattern[0].toLowerCase()}…"`, tone: "error" });
  }

  if (out.length === 0) return fallbackSuggestions;
  while (out.length < 3) {
    const filler = fallbackSuggestions.find((s) => !seen.has(s.text.toLowerCase()));
    if (!filler) break;
    add(filler);
  }
  return out.slice(0, 5);
}

type LogColumnKey = "level" | "date" | "env" | "host" | "service" | "content";

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

function firstFieldValue(row: LogRow, fields: string[]): string {
  for (const field of fields) {
    const value = asText(row[field]);
    if (value) return value;
  }
  return "";
}

function message(row: LogRow): string {
  return asText(row._msg ?? row.message ?? row.msg ?? row.log);
}

function timeValue(row: LogRow): string {
  return asText(row._time ?? row.timestamp ?? row.time);
}

function normalizeIsoTimestamp(value: string): string {
  return value.replace(/(\.\d{3})\d+(Z|[+-]\d{2}:?\d{2})$/, "$1$2");
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function localTimeValue(row: LogRow): string {
  const raw = timeValue(row);
  if (!raw) return "";
  const date = new Date(normalizeIsoTimestamp(raw));
  if (Number.isNaN(date.getTime())) return raw;
  const month = date.toLocaleString(undefined, { month: "short" });
  const day = date.getDate();
  return `${month} ${day}  ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function rowTimestamp(row: LogRow): number {
  const raw = timeValue(row);
  if (!raw) return NaN;
  return new Date(normalizeIsoTimestamp(raw)).getTime();
}

function severityKey(level: string): "error" | "warning" | "info" | "debug" | "other" {
  const c = canonicalLevel(level);
  if (c === "error" || c === "fatal" || c === "critical") return "error";
  if (c === "warning" || c === "warn") return "warning";
  if (c === "info") return "info";
  if (c === "debug" || c === "trace" || c === "verbose") return "debug";
  return "other";
}

function levelLabel(level: string): string {
  const k = severityKey(level);
  if (k === "error") return "ERR";
  if (k === "warning") return "WRN";
  if (k === "info") return "INF";
  if (k === "debug") return "DBG";
  return level ? level.slice(0, 3).toUpperCase() : "—";
}

function levelValue(row: LogRow): string {
  return asText(row.level ?? row.Level ?? row.severity ?? "info");
}

function fieldValue(row: LogRow, field: string): string {
  if (field === "service") return serviceValue(row);
  if (field === "host" || field === "hostname") return hostValue(row);
  return asText(row[field]);
}

function envValue(row: LogRow): string {
  return asText(row.environment ?? row.env ?? row.Environment);
}

function hostValue(row: LogRow): string {
  return firstFieldValue(row, hostFields);
}

function serviceValue(row: LogRow): string {
  return firstFieldValue(row, serviceFields);
}

function countFromHit(hit: Record<string, unknown>): number {
  const value = hit.hits ?? hit.count ?? hit.logs ?? 0;
  return typeof value === "number" ? value : Number(value) || 0;
}

function quoteValue(value: string): string {
  return JSON.stringify(value);
}

function canonicalLevel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["err", "error", "fatal", "critical"].includes(normalized)) return "error";
  if (["warn", "warning"].includes(normalized)) return "warning";
  if (["info", "information"].includes(normalized)) return "info";
  if (["debug", "trace", "verbose"].includes(normalized)) return normalized;
  return normalized;
}

function displayFacetValue(field: string, value: string): string {
  if (field !== "level") return value;
  const normalized = canonicalLevel(value);
  if (normalized === "error") return "error";
  if (normalized === "warning") return "warning";
  if (normalized === "info") return "info";
  return normalized;
}

function levelVariants(value: string): string[] {
  const normalized = canonicalLevel(value);
  if (normalized === "error") return ["error", "Error", "ERROR", "err", "fatal", "Fatal", "critical", "Critical"];
  if (normalized === "warning") return ["warning", "Warning", "WARNING", "warn", "Warn", "WARN"];
  if (normalized === "info") return ["info", "Info", "INFO", "information", "Information", "INFORMATION"];
  if (normalized === "debug") return ["debug", "Debug", "DEBUG"];
  if (normalized === "trace") return ["trace", "Trace", "TRACE", "verbose", "Verbose", "VERBOSE"];
  return [value];
}

function aliasFieldsForFilter(field: string): string[] {
  if (field === "service") return serviceFields;
  if (field === "host" || field === "hostname") return hostFields;
  return [field];
}

function filterToken(field: string, value: string): string {
  const cleanValue = value.trim();
  if (!field || !cleanValue) return "";
  if (field === "level") {
    return `(${levelVariants(cleanValue).map((variant) => `${field}:${quoteValue(variant)}`).join(" OR ")})`;
  }
  const fields = aliasFieldsForFilter(field);
  if (fields.length > 1) {
    return `(${fields.map((alias) => `${alias}:${quoteValue(cleanValue)}`).join(" OR ")})`;
  }
  return `${fields[0]}:${quoteValue(cleanValue)}`;
}

function addFilterToQuery(currentQuery: string, token: string): string {
  if (!token) return currentQuery;
  if (currentQuery.includes(token)) return currentQuery;
  return `${currentQuery.trim()} ${token}`.trim();
}

function filterTokenForValues(field: string, values: string[]): string {
  const cleanValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  if (cleanValues.length === 0) return "";
  if (cleanValues.length === 1) return filterToken(field, cleanValues[0]);
  const tokens = cleanValues.map((value) => {
    if (field === "level") {
      return levelVariants(value).map((variant) => `${field}:${quoteValue(variant)}`);
    }
    return aliasFieldsForFilter(field).map((alias) => `${alias}:${quoteValue(value)}`);
  }).flat();
  return `(${Array.from(new Set(tokens)).join(" OR ")})`;
}

function stripAppliedFilterTokens(query: string, filters: AppliedFilter[]): string {
  let next = query;
  Array.from(new Set(filters.map((filter) => filter.token).filter(Boolean)))
    .sort((left, right) => right.length - left.length)
    .forEach((token) => {
      next = next.split(token).join("");
    });
  return next.replace(/\s+/g, " ").trim() || "_time:15m";
}

function buildQueryWithFilters(query: string, currentFilters: AppliedFilter[], nextFilters: AppliedFilter[]) {
  let nextQuery = stripAppliedFilterTokens(query, currentFilters);
  const grouped = new Map<string, AppliedFilter[]>();
  nextFilters.forEach((filter) => {
    const group = grouped.get(filter.field) ?? [];
    group.push(filter);
    grouped.set(filter.field, group);
  });

  const filtersWithTokens: AppliedFilter[] = [];
  grouped.forEach((group, field) => {
    const token = filterTokenForValues(field, group.map((filter) => filter.value));
    if (!token) return;
    nextQuery = addFilterToQuery(nextQuery, token);
    group.forEach((filter) => filtersWithTokens.push({ ...filter, token }));
  });

  return { query: nextQuery, filters: filtersWithTokens };
}

function mergeFacetValues(field: string, ...sets: Array<ValueHit[] | undefined>): ValueHit[] {
  const values = new Map<string, number>();
  sets.forEach((set) => {
    set?.forEach((item) => {
      const displayValue = displayFacetValue(field, item.value.trim());
      if (!displayValue) return;
      values.set(displayValue, Math.max(values.get(displayValue) ?? 0, item.hits));
    });
  });
  return [...values.entries()]
    .map(([value, hits]) => ({ value, hits }))
    .sort((left, right) => right.hits - left.hits || left.value.localeCompare(right.value));
}

type EntityKind = "service" | "host" | "env" | "status" | "level";

type EntityMap = Record<EntityKind, Set<string>>;

function buildEntityMap(rows: LogRow[]): EntityMap {
  const map: EntityMap = {
    service: new Set(),
    host: new Set(),
    env: new Set(),
    status: new Set(),
    level: new Set()
  };
  rows.forEach((row) => {
    const s = serviceValue(row);
    if (s) map.service.add(s);
    const h = hostValue(row);
    if (h) map.host.add(h);
    const e = envValue(row);
    if (e) map.env.add(e);
    const st = asText(row.status);
    if (st) map.status.add(st);
    const l = levelValue(row);
    if (l) map.level.add(l);
  });
  return map;
}

const fieldByEntity: Record<EntityKind, string> = {
  service: "service",
  host: "host",
  env: "environment",
  status: "status",
  level: "level"
};

function inlineFormat(segment: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|"([^"]+)"/g;
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    if (match.index > cursor) out.push(segment.slice(cursor, match.index));
    if (match[1] !== undefined) {
      out.push(<strong key={`fmt-${key++}`}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      out.push(<code key={`fmt-${key++}`}>{match[2]}</code>);
    } else if (match[3] !== undefined) {
      out.push(<q key={`fmt-${key++}`}>{match[3]}</q>);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < segment.length) out.push(segment.slice(cursor));
  return out;
}

function renderWithEntities(
  text: string,
  entities: EntityMap,
  onClickEntity: (kind: EntityKind, value: string) => void
): React.ReactNode {
  if (!text) return null;
  const matches: Array<{ start: number; end: number; kind: EntityKind; value: string }> = [];
  const haystack = text.toLowerCase();
  (Object.keys(entities) as EntityKind[]).forEach((kind) => {
    entities[kind].forEach((value) => {
      if (!value || value.length < 2) return;
      const needle = value.toLowerCase();
      let idx = 0;
      while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        const before = idx > 0 ? haystack[idx - 1] : " ";
        const after = idx + needle.length < haystack.length ? haystack[idx + needle.length] : " ";
        const isWordBoundary = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
        if (isWordBoundary) {
          matches.push({ start: idx, end: idx + needle.length, kind, value });
        }
        idx += needle.length;
      }
    });
  });
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const filtered: typeof matches = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start < lastEnd) continue;
    filtered.push(m);
    lastEnd = m.end;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  filtered.forEach((m, i) => {
    if (m.start > cursor) parts.push(...inlineFormat(text.slice(cursor, m.start)));
    parts.push(
      <button
        key={`ent-${i}`}
        type="button"
        className={`entity entity-${m.kind}`}
        onClick={() => onClickEntity(m.kind, m.value)}
        title={`Filter by ${m.kind}: ${m.value}`}
      >
        {text.slice(m.start, m.end)}
      </button>
    );
    cursor = m.end;
  });
  if (cursor < text.length) parts.push(...inlineFormat(text.slice(cursor)));
  return parts;
}

function HikariSparkle({ size = 18, glow = true }: { size?: number; glow?: boolean }) {
  const id = `hikari-grad-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ display: "block", filter: glow ? "drop-shadow(0 0 6px rgba(95,225,255,0.6))" : undefined }}>
      <defs>
        <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#5fe1ff" />
          <stop offset="55%" stopColor="#b277ff" />
          <stop offset="100%" stopColor="#ff5fc8" />
        </linearGradient>
      </defs>
      <path
        d="M16 2 C 17 11, 21 15, 30 16 C 21 17, 17 21, 16 30 C 15 21, 11 17, 2 16 C 11 15, 15 11, 16 2 Z"
        fill={`url(#${id})`}
      />
      <path
        d="M16 9 C 16.5 13.5, 18.5 15.5, 23 16 C 18.5 16.5, 16.5 18.5, 16 23 C 15.5 18.5, 13.5 16.5, 9 16 C 13.5 15.5, 15.5 13.5, 16 9 Z"
        fill="rgba(255,255,255,0.85)"
      />
    </svg>
  );
}

function buildFindings(rows: LogRow[]): string[] {
  if (rows.length === 0) return [];
  const findings: string[] = [];

  const counts = { error: 0, warning: 0, info: 0, debug: 0, other: 0 };
  rows.forEach((row) => {
    counts[severityKey(levelValue(row))] += 1;
  });
  const errorPct = Math.round((counts.error / rows.length) * 100);
  if (counts.error > 0) {
    findings.push(`**${counts.error}** of ${rows.length} matches are errors (${errorPct}%); ${counts.warning} warnings, ${counts.info} info.`);
  } else if (counts.warning > 0) {
    findings.push(`No errors in this set — ${counts.warning} warnings and ${counts.info} info events.`);
  } else {
    findings.push(`${rows.length} events, all informational — no errors or warnings in this slice.`);
  }

  const errorRows = rows.filter((row) => severityKey(levelValue(row)) === "error");
  const targetRows = errorRows.length >= 3 ? errorRows : rows;
  const labelForTarget = errorRows.length >= 3 ? "failure" : "event";

  const patternCounts = topByCount(targetRows, (row) => {
    const head = message(row).split(/[,;:.]/)[0].trim();
    return head.length >= 8 ? head : undefined;
  });
  if (patternCounts.length > 0 && patternCounts[0][1] >= 2) {
    const [pattern, count] = patternCounts[0];
    findings.push(`Most common ${labelForTarget}: "${pattern}…" (${count} occurrences).`);
  }

  const hostCounts = topByCount(targetRows, (row) => hostValue(row) || undefined);
  if (hostCounts.length > 0 && hostCounts[0][1] >= 2) {
    const [host, count] = hostCounts[0];
    const pct = Math.round((count / targetRows.length) * 100);
    if (pct >= 35) findings.push(`Concentrated on host ${host} (${pct}% of ${labelForTarget}s).`);
  }

  const envCounts = topByCount(targetRows, (row) => envValue(row) || undefined);
  if (envCounts.length === 1 && envCounts[0][1] >= 3) {
    findings.push(`All in **${envCounts[0][0]}** environment.`);
  } else if (envCounts.length >= 2) {
    const top = envCounts.slice(0, 3).map(([e, c]) => `${e} (${c})`).join(", ");
    findings.push(`Spread across environments: ${top}.`);
  }

  const statusCounts = topByCount(rows, (row) => {
    const s = asText(row.status);
    return s && !s.startsWith("2") && !s.startsWith("1") ? s : undefined;
  });
  if (statusCounts.length > 0) {
    const top = statusCounts.slice(0, 3).map(([s, c]) => `${s} (${c})`).join(", ");
    findings.push(`Non-2xx status codes: ${top}.`);
  }

  const times = targetRows
    .map(rowTimestamp)
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (times.length >= 3) {
    const spanMin = (times[times.length - 1] - times[0]) / 1000 / 60;
    if (spanMin < 3) {
      findings.push(`Burst pattern: all ${labelForTarget}s landed within ${Math.max(1, Math.ceil(spanMin))} minute${Math.ceil(spanMin) === 1 ? "" : "s"}.`);
    } else if (spanMin > 12 && targetRows.length >= 6) {
      const ratePerMin = (targetRows.length / spanMin).toFixed(1);
      findings.push(`Sustained activity: ~${ratePerMin} ${labelForTarget}s/minute over ${Math.round(spanMin)} minutes.`);
    }
  }

  return findings;
}

function topLevelTokens(query: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i];
    if (ch === "(") {
      depth += 1;
      current += ch;
    } else if (ch === ")") {
      depth -= 1;
      current += ch;
    } else if (ch === '"') {
      current += ch;
      i += 1;
      while (i < query.length && query[i] !== '"') {
        current += query[i];
        i += 1;
      }
      if (i < query.length) current += query[i];
    } else if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function relaxQuery(query: string): string | null {
  const tokens = topLevelTokens(query);
  if (tokens.length <= 1) return null;

  const dropPriority = [/^_msg:/i, /^message:/i, /^msg:/i, /^level:/i, /^status:/i, /^client:/i, /^source:/i, /^host:/i, /^hostname:/i, /^kubernetes\./i, /^environment:/i, /^env:/i, /^service:/i, /^\(.+\)$/];
  for (const re of dropPriority) {
    const idx = tokens.findIndex((token) => re.test(token));
    if (idx !== -1) {
      const next = tokens.slice();
      next.splice(idx, 1);
      while (next.length && /^(and|or)$/i.test(next[next.length - 1])) next.pop();
      while (next.length && /^(and|or)$/i.test(next[0])) next.shift();
      const result = next.join(" ").trim();
      return result === query.trim() ? null : result;
    }
  }
  return null;
}

function App() {
  const initialLogQuery = logQueryFromUrl();
  const [query, setQuery] = useState(initialLogQuery);
  const [draftQuery, setDraftQuery] = useState(initialLogQuery);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiExplanation, setAiExplanation] = useState("");
  const [aiEvidence, setAiEvidence] = useState<string[]>([]);
  const [aiRelaxations, setAiRelaxations] = useState<string[]>([]);
  const [rows, setRows] = useState<LogRow[]>(sampleRows);
  const [hits, setHits] = useState<Array<Record<string, unknown>>>([]);
  const [fields, setFields] = useState<string[]>(defaultFields);
  const [facets, setFacets] = useState<Record<string, ValueHit[]>>({});
  const [facetCache, setFacetCache] = useState<Record<string, ValueHit[]>>({});
  const [facetSearch, setFacetSearch] = useState("");
  const [selected, setSelected] = useState<LogRow | null>(null);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [manualField, setManualField] = useState("host");
  const [manualValue, setManualValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiSteps, setAiSteps] = useState<AiStep[]>([]);
  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"off" | "connecting" | "streaming" | "reconnecting" | "error">("off");
  const [mode, setMode] = useState<ViewMode>(() => modeFromPath(window.location.pathname));
  const tailRef = useRef<EventSource | null>(null);
  const aiCloseTimerRef = useRef<number | null>(null);
  const manualValueRef = useRef<HTMLInputElement | null>(null);
  const tailSeenRef = useRef<Set<string>>(new Set());
  const tailQueueRef = useRef<LogRow[]>([]);
  const constellationRef = useRef<HTMLDivElement | null>(null);
  const tailRecentRef = useRef<LogRow[]>([]);
  const selectedEventIdRef = useRef<string | null>(selectedEventIdFromUrl());

  function updateAppUrl(nextMode: ViewMode, eventId?: string | null, replace = false, nextQuery = query) {
    if (!["/", "/browse"].includes(window.location.pathname)) return;
    const next = buildAppUrl(nextMode, eventId, nextQuery);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === next) return;
    window.history[replace ? "replaceState" : "pushState"]({}, "", next);
  }

  function selectLogEvent(row: LogRow, replace = false) {
    const id = storeLogEvent(row);
    selectedEventIdRef.current = id;
    setSelected(row);
    setMode("explore");
    updateAppUrl("explore", id, replace);
  }

  function clearSelectedLogEvent(replace = false) {
    selectedEventIdRef.current = null;
    setSelected(null);
    if (window.location.pathname === "/browse") updateAppUrl("explore", null, replace);
  }

  function restoreSelectedLogEvent(nextRows = rows) {
    const id = selectedEventIdFromUrl();
    selectedEventIdRef.current = id;
    if (!id) {
      setSelected(null);
      return;
    }
    const row = rowForEventId(id, nextRows);
    if (row) setSelected(row);
  }

  useEffect(() => {
    function handlePopState() {
      const nextMode = modeFromPath(window.location.pathname);
      const nextQuery = logQueryFromUrl();
      setMode(nextMode);
      setQuery(nextQuery);
      setDraftQuery(nextQuery);
      if (nextMode === "explore") {
        restoreSelectedLogEvent();
        void runSearch(nextQuery, { replaceUrl: true });
      } else {
        selectedEventIdRef.current = null;
        setSelected(null);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (mode !== "explore") {
      selectedEventIdRef.current = null;
      if (selected) setSelected(null);
    }
    updateAppUrl(mode, mode === "explore" ? selectedEventIdRef.current : null);
  }, [mode, selected]);

  async function runSearch(nextQuery = draftQuery, options: { relaxIfEmpty?: boolean; replaceUrl?: boolean } = {}) {
    setLoading(true);
    setError("");
    try {
      let activeQuery = nextQuery;
      let searchResult = await searchLogs(activeQuery);
      const relaxations: string[] = [];
      if (options.relaxIfEmpty) {
        let attempts = 0;
        while ((searchResult.rows?.length ?? 0) === 0 && attempts < 4) {
          const relaxed = relaxQuery(activeQuery);
          if (!relaxed || relaxed === activeQuery) break;
          relaxations.push(relaxed);
          activeQuery = relaxed;
          searchResult = await searchLogs(activeQuery);
          attempts += 1;
        }
      }
      const [hitResult, fieldResult] = await Promise.all([
        getHits(activeQuery),
        getFields(activeQuery)
      ]);
      const nextRows = searchResult.rows.length ? searchResult.rows : [];
      setRows(nextRows);
      const selectedId = selectedEventIdFromUrl();
      if (selectedId) {
        selectedEventIdRef.current = selectedId;
        setSelected(rowForEventId(selectedId, nextRows));
      } else {
        setSelected(null);
      }
      setQuery(activeQuery);
      if (relaxations.length === 0) setDraftQuery(activeQuery);
      if (mode === "explore") {
        updateAppUrl("explore", selectedEventIdRef.current, options.replaceUrl ?? false, activeQuery);
      }
      setAiRelaxations(relaxations);
      setHits(hitResult.values ?? []);
      const nextFields = (fieldResult.values ?? [])
        .map((item) => item.value.trim())
        .filter(Boolean)
        .slice(0, 24);
      setFields(Array.from(new Set([...defaultFields, ...nextFields])));
      return { query: activeQuery, relaxations };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      return { query: nextQuery, relaxations: [] };
    } finally {
      setLoading(false);
    }
  }

  async function loadFacet(field: string) {
    try {
      const fieldsToLoad = aliasFieldsForFilter(field);
      const results = await Promise.all(fieldsToLoad.map((sourceField) => getFieldValues(query, sourceField)));
      const nextValues = mergeFacetValues(field, ...results.map((result) => result.values));
      setFacets((current) => ({
        ...current,
        [field]: nextValues
      }));
      setFacetCache((current) => ({
        ...current,
        [field]: mergeFacetValues(field, current[field], nextValues)
      }));
    } catch {
      setFacets((current) => ({ ...current, [field]: [] }));
    }
  }

  function rowFacetValues(field: string): ValueHit[] {
    const counts = new Map<string, number>();
    rows.forEach((row) => {
      const value = fieldValue(row, field).trim();
      if (!value) return;
      const displayValue = displayFacetValue(field, value);
      counts.set(displayValue, (counts.get(displayValue) ?? 0) + 1);
    });
    return [...counts.entries()]
      .map(([value, count]) => ({ value, hits: count }))
      .sort((left, right) => right.hits - left.hits)
      .slice(0, 12);
  }

  function valuesForField(field: string): ValueHit[] {
    return mergeFacetValues(field, facets[field], facetCache[field], rowFacetValues(field));
  }

  function applyFilter(field: string, value: string) {
    const cleanValue = value.trim();
    if (!field || !cleanValue) return;
    const displayValue = displayFacetValue(field, cleanValue);
    if (appliedFilters.some((item) => item.field === field && item.value === displayValue)) return;
    const nextFilters = [...appliedFilters, { field, value: displayValue, token: "" }];
    const next = buildQueryWithFilters(draftQuery, appliedFilters, nextFilters);
    setDraftQuery(next.query);
    setAppliedFilters(next.filters);
    void runSearch(next.query);
  }

  function submitManualFilter() {
    if (manualValue.trim()) {
      applyFilter(manualField, manualValue);
      setManualValue("");
      return;
    }
    manualValueRef.current?.focus();
  }

  function toggleFilter(field: string, value: string) {
    const displayValue = displayFacetValue(field, value);
    const existing = appliedFilters.find((item) => item.field === field && item.value === displayValue);
    if (existing) {
      removeFilter(existing);
      return;
    }
    applyFilter(field, displayValue);
  }

  function removeFilter(filter: AppliedFilter) {
    const nextFilters = appliedFilters.filter((item) => !(item.field === filter.field && item.value === filter.value));
    const next = buildQueryWithFilters(draftQuery, appliedFilters, nextFilters);
    setDraftQuery(next.query);
    setAppliedFilters(next.filters);
    void runSearch(next.query);
  }

  async function askAi(promptOverride?: string) {
    const promptToUse = (promptOverride ?? aiPrompt).trim();
    if (!promptToUse) return;
    if (promptOverride) setAiPrompt(promptOverride);
    const startedFromExplore = mode === "explore";
    setLoading(true);
    setError("");
    if (aiCloseTimerRef.current !== null) window.clearTimeout(aiCloseTimerRef.current);
    setAiModalOpen(true);
    setAiRunning(true);
    const timer = beginAiProgress();
    try {
      const result = await generateQuery(promptToUse, draftQuery, fields);
      window.clearInterval(timer);
      setAiSteps((current) => current.map((step) => ({ ...step, status: "done" as const })));
      setDraftQuery(result.query);
      setAiExplanation(result.explanation || "");
      setAiEvidence(result.evidence ?? []);
      aiCloseTimerRef.current = window.setTimeout(() => {
        setAiModalOpen(false);
        aiCloseTimerRef.current = null;
      }, 220);
      if (!startedFromExplore) setMode("answer");
      void runSearch(result.query, { relaxIfEmpty: true });
    } catch (err) {
      window.clearInterval(timer);
      const message = err instanceof Error ? err.message : "AI query generation failed";
      setError(message);
      setAiSteps((current) => [
        ...current.map((step) => (step.status === "running" ? { ...step, status: "error" as const } : step)),
        { title: "AI request failed", status: "error", detail: message }
      ]);
    } finally {
      setAiRunning(false);
      setLoading(false);
    }
  }

  function beginAiProgress(): number {
    let cursor = 0;
    setAiSteps(aiProgressTemplate.map((step, index) => ({ ...step, status: index === 0 ? "running" : "pending" })));
    const timer = window.setInterval(() => {
      cursor += 1;
      setAiSteps((current) =>
        current.map((step, index) => {
          if (index < cursor) return { ...step, status: "done" };
          if (index === cursor) return { ...step, status: "running" };
          return { ...step, status: "pending" };
        })
      );
      if (cursor >= aiProgressTemplate.length - 1) window.clearInterval(timer);
    }, 900);
    return timer;
  }

  function completedAiSteps(explanation: string, nextQuery: string): AiStep[] {
    return [
      ...aiProgressTemplate.slice(0, -1),
      {
        title: "Generated and normalized LogsQL",
        status: "done",
        detail: explanation,
        items: [nextQuery]
      }
    ];
  }

  function downloadRows() {
    const blob = new Blob([rows.map((row) => JSON.stringify(row)).join("\n")], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "hikari.ndjson";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    void runSearch(logQueryFromUrl(), { replaceUrl: true });
  }, []);

  useEffect(() => {
    if (mode === "explore") restoreSelectedLogEvent();
  }, []);

  useEffect(() => {
    return () => {
      if (aiCloseTimerRef.current !== null) window.clearTimeout(aiCloseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    priorityFilters.forEach(({ field }) => {
      if (!facets[field]) void loadFacet(field);
    });
  }, [query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") clearSelectedLogEvent();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    tailRef.current?.close();
    const shouldStream = live || mode === "welcome";
    if (!shouldStream) {
      setLiveStatus("off");
      return;
    }
    setLiveStatus("connecting");
    const source = new EventSource(tailUrl(query));
    tailRef.current = source;
    source.onopen = () => setLiveStatus("streaming");
    source.onmessage = (event) => {
      try {
        const row = JSON.parse(event.data) as LogRow;
        setRows((current) => [row, ...current].slice(0, 500));
      } catch {
        setRows((current) => [{ _time: new Date().toISOString(), _msg: event.data }, ...current].slice(0, 500));
      }
    };
    source.onerror = () => setLiveStatus(source.readyState === EventSource.CLOSED ? "error" : "reconnecting");
    return () => {
      source.close();
      setLiveStatus("off");
    };
  }, [live, query, mode]);

  const histogram = useMemo(() => {
    const buckets = 60;
    const times = rows.map(rowTimestamp).filter((value) => !Number.isNaN(value));
    if (times.length === 0) return [];
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const span = Math.max(1000, maxTime - minTime);
    const step = span / buckets;
    const counts: Array<{ error: number; warning: number; info: number; other: number }> = Array.from(
      { length: buckets },
      () => ({ error: 0, warning: 0, info: 0, other: 0 })
    );
    rows.forEach((row) => {
      const t = rowTimestamp(row);
      if (Number.isNaN(t)) return;
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((t - minTime) / step)));
      const key = severityKey(levelValue(row));
      if (key === "error") counts[idx].error += 1;
      else if (key === "warning") counts[idx].warning += 1;
      else if (key === "info") counts[idx].info += 1;
      else counts[idx].other += 1;
    });
    const totals = counts.map((c) => c.error + c.warning + c.info + c.other);
    const maxTotal = Math.max(1, ...totals);
    return counts.map((c, i) => {
      const total = totals[i];
      const height = total === 0 ? 0 : Math.max(3, Math.round((total / maxTotal) * 72));
      return {
        key: i,
        total,
        height,
        error: total ? (c.error / total) * 100 : 0,
        warning: total ? (c.warning / total) * 100 : 0,
        info: total ? (c.info / total) * 100 : 0,
        other: total ? (c.other / total) * 100 : 0
      };
    });
  }, [rows]);

  const logColumns = useMemo(() => {
    function valueCount(getValue: (row: LogRow) => string): number {
      return rows.reduce((count, row) => count + (getValue(row).trim().length > 0 ? 1 : 0), 0);
    }

    function hasUsefulValue(getValue: (row: LogRow) => string): boolean {
      const populated = valueCount(getValue);
      if (populated === 0) return false;
      return populated >= Math.min(8, Math.max(2, Math.ceil(rows.length * 0.05)));
    }

    function widthFor(label: string, getValue: (row: LogRow) => string, min: number, max: number): string {
      const longest = Math.max(label.length, ...rows.slice(0, 500).map((row) => getValue(row).length));
      return `${Math.min(max, Math.max(min, longest + 2)) * 8}px`;
    }

    const columns: Array<{ key: LogColumnKey; label: string; width: string }> = [
      { key: "level", label: "Lvl", width: "44px" },
      { key: "date", label: "Time", width: widthFor("Time", localTimeValue, 16, 20) }
    ];
    if (hasUsefulValue(envValue)) columns.push({ key: "env", label: "Env", width: widthFor("Env", envValue, 6, 14) });
    if (hasUsefulValue(hostValue)) columns.push({ key: "host", label: "Host", width: widthFor("Host", hostValue, 8, 32) });
    if (hasUsefulValue(serviceValue)) columns.push({ key: "service", label: "Service", width: widthFor("Service", serviceValue, 9, 24) });
    columns.push({ key: "content", label: "Message", width: "minmax(0, 1fr)" });

    return {
      columns,
      style: { "--log-grid-columns": columns.map((column) => column.width).join(" ") } as React.CSSProperties
    };
  }, [rows]);

  const trendingSuggestions = useMemo(() => buildTrendingSuggestions(rows), [rows]);

  const mood = useMemo(() => deriveMood(rows), [rows]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--ambient-hue", String(mood.hue));
    root.style.setProperty("--ambient-saturation", `${mood.saturation}%`);
    root.style.setProperty("--ambient-intensity", String(mood.intensity));
    root.dataset.mood = mood.label;
  }, [mood]);

  // Watch `rows` for new entries — push them onto the tail queue (de-duped).
  useEffect(() => {
    if (rows.length === 0) return;
    const seen = tailSeenRef.current;
    const isInitialSeed = seen.size === 0;

    if (isInitialSeed) {
      rows.forEach((row) => {
        seen.add(`${timeValue(row)}|${message(row)}`);
      });
      // Sort the most-recent batch ascending by time so older comes out of the queue first; that way
      // the track ends up with oldest at the top of the column and newest at the bottom (= visual
      // bottom near the viewport floor, with newer rows scrolling up off the top over time).
      const seedCount = Math.min(rows.length, 40);
      const seed = rows.slice(0, seedCount * 2)
        .sort((a, b) => rowTimestamp(a) - rowTimestamp(b))
        .slice(-seedCount);
      tailRecentRef.current = seed;
      tailQueueRef.current.push(...seed);
      return;
    }

    const newOnes: LogRow[] = [];
    for (const row of rows) {
      const key = `${timeValue(row)}|${message(row)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      newOnes.push(row);
    }
    if (newOnes.length === 0) return;
    newOnes.sort((a, b) => rowTimestamp(a) - rowTimestamp(b));
    tailQueueRef.current.push(...newOnes);
    if (tailQueueRef.current.length > 200) {
      tailQueueRef.current = tailQueueRef.current.slice(-200);
    }
  }, [rows]);

  // Severity Constellation — fixed starfield. Stars are positioned randomly on mount and
  // gently twinkle. When a log event arrives, a random star flashes briefly in that severity's
  // color (cyan info / amber warning / magenta error). Reads as "the sky reacts to activity".
  useEffect(() => {
    const field = constellationRef.current;
    if (!field) return;
    const STAR_COUNT = 220;
    // Clear any prior children (HMR safety)
    while (field.firstChild) field.removeChild(field.firstChild);
    for (let i = 0; i < STAR_COUNT; i++) {
      const s = document.createElement("div");
      s.className = "star";
      s.style.top = `${Math.random() * 100}%`;
      s.style.left = `${Math.random() * 100}%`;
      const size = 1.4 + Math.random() * 2.2;
      s.style.width = `${size}px`;
      s.style.height = `${size}px`;
      s.style.setProperty("--twinkle-duration", `${4 + Math.random() * 6}s`);
      s.style.setProperty("--twinkle-delay", `${Math.random() * 8}s`);
      // baseline brightness variance
      s.style.setProperty("--baseline-opacity", `${0.25 + Math.random() * 0.5}`);
      field.append(s);
    }
  }, []);

  useEffect(() => {
    const INTERVAL_MS = 520;

    function flashRandom(sev: string) {
      const field = constellationRef.current;
      if (!field) return;
      const all = field.querySelectorAll<HTMLDivElement>(".star");
      if (all.length === 0) return;
      // Find a star not already flashing — try up to 6 picks
      let target: HTMLDivElement | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = all[Math.floor(Math.random() * all.length)];
        if (!candidate.classList.contains("flashing")) {
          target = candidate;
          break;
        }
      }
      if (!target) return;
      target.classList.add("flashing", `flash-${sev}`);
      const onEnd = () => {
        target!.classList.remove("flashing", `flash-${sev}`);
        target!.removeEventListener("animationend", onEnd);
      };
      target.addEventListener("animationend", onEnd);
    }

    function drain() {
      if (tailQueueRef.current.length === 0) return;
      const next = tailQueueRef.current.shift();
      if (!next) return;
      const sev = severityKey(levelValue(next));
      flashRandom(sev);
    }

    const interval = window.setInterval(drain, INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const totalLogs = useMemo(() => {
    const apiTotal = hits.reduce((sum, h) => sum + countFromHit(h), 0);
    if (apiTotal > 0) return apiTotal;
    return rows.length;
  }, [hits, rows]);

  const totalLogsDisplay = useMemo(() => {
    const apiTotal = hits.reduce((sum, h) => sum + countFromHit(h), 0);
    if (apiTotal > 0 && apiTotal !== rows.length) return apiTotal.toLocaleString();
    if (rows.length >= 500) return "500+";
    return rows.length.toLocaleString();
  }, [hits, rows]);

  const severityCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0, debug: 0, other: 0 };
    const levelFacet = facets.level;
    if (levelFacet && levelFacet.length > 0) {
      levelFacet.forEach((item) => {
        counts[severityKey(item.value)] += item.hits;
      });
      return counts;
    }
    rows.forEach((row) => {
      counts[severityKey(levelValue(row))] += 1;
    });
    return counts;
  }, [rows, facets]);

  function runSuggestion(prompt: string) {
    void askAi(prompt);
  }

  const findings = useMemo(() => buildFindings(rows), [rows]);

  const entityMap = useMemo<EntityMap>(() => {
    const map = buildEntityMap(rows);
    tailRecentRef.current.forEach((row) => {
      const s = serviceValue(row); if (s) map.service.add(s);
      const h = hostValue(row); if (h) map.host.add(h);
      const e = envValue(row); if (e) map.env.add(e);
      const st = asText(row.status); if (st) map.status.add(st);
      const l = levelValue(row); if (l) map.level.add(l);
    });
    facets.service?.forEach((item) => item.value && map.service.add(item.value));
    facets.host?.forEach((item) => item.value && map.host.add(item.value));
    facets.hostname?.forEach((item) => item.value && map.host.add(item.value));
    facets.environment?.forEach((item) => item.value && map.env.add(item.value));
    facets.level?.forEach((item) => item.value && map.level.add(item.value));
    facets.status?.forEach((item) => item.value && map.status.add(item.value));
    return map;
  }, [rows, facets]);

  const facetDefinitions = useMemo(() => {
    const known = new Set([...priorityFilters.map((filter) => filter.field), ...hostFields, ...serviceFields]);
    return [
      ...priorityFilters,
      ...fields
        .filter((field) => !known.has(field))
        .map((field) => ({ field, label: field }))
    ];
  }, [fields]);

  const visibleFacetDefinitions = useMemo(() => {
    const term = facetSearch.trim().toLowerCase();
    if (!term) return facetDefinitions;
    return facetDefinitions.filter(({ field, label }) => {
      if (field.toLowerCase().includes(term) || label.toLowerCase().includes(term)) return true;
      return valuesForField(field).some((item) => item.value.toLowerCase().includes(term));
    });
  }, [facetDefinitions, facetSearch, facets, facetCache, rows]);

  function visibleValuesForField(field: string, label: string): ValueHit[] {
    const values = valuesForField(field);
    const term = facetSearch.trim().toLowerCase();
    if (!term) return values;
    if (field.toLowerCase().includes(term) || label.toLowerCase().includes(term)) return values;
    return values.filter((item) => item.value.toLowerCase().includes(term));
  }

  function handleEntityClick(kind: EntityKind, value: string) {
    const field = fieldByEntity[kind];
    setMode("explore");
    applyFilter(field, value);
  }

  const answerSamples = useMemo<{ rows: LogRow[]; fallback: boolean; targetService: string }>(() => {
    if (rows.length > 0) return { rows: rows.slice(0, 12), fallback: false, targetService: "" };
    const match = query.match(/service:"([^"]+)"/);
    const targetService = match?.[1] ?? "";
    const recent = tailRecentRef.current;
    const pool = targetService
      ? recent.filter((row) => serviceValue(row) === targetService)
      : recent;
    const fallback = pool.length > 0 ? pool : recent;
    const slice = fallback.slice(-12).reverse();
    return { rows: slice, fallback: true, targetService };
  }, [rows, query]);

  function renderLogCell(column: LogColumnKey, row: LogRow) {
    if (column === "level") {
      const level = levelValue(row);
      return <span className={`level-badge ${severityKey(level)}`} title={level}>{levelLabel(level)}</span>;
    }
    if (column === "date") return <time dateTime={timeValue(row)} title={timeValue(row)}>{localTimeValue(row) || "live"}</time>;
    if (column === "env") return <span className="env">{envValue(row)}</span>;
    if (column === "host") return <span className="host">{hostValue(row)}</span>;
    if (column === "service") return <span className="service">{serviceValue(row)}</span>;
    return <span className="msg">{message(row)}</span>;
  }

  return (
    <>
    <div className={`shell ${mode !== "explore" ? "shell-dimmed" : ""}`} aria-hidden={mode !== "explore"}>
      <header className="app-chrome">
        <div className="product">
          <div className="mark" aria-label="Hikari"><HikariSparkle size={20} /></div>
          <div>
            <strong>Hikari</strong>
            <span>Log analysis system</span>
          </div>
        </div>
        <div className="time-controls">
          {mode === "explore" && (
            <button className="ask-ai-button" onClick={() => setMode("welcome")} title="Ask AI">
              <Sparkles size={14} />
              <span>Ask AI</span>
            </button>
          )}
          <button className="time-button" title="Time range">
            <Clock size={15} />
            <strong>15m</strong>
            <span>Past 15 Minutes</span>
          </button>
          <button className="icon-button" onClick={() => setLive((current) => !current)} title={live ? "Pause live tail" : "Start live tail"}>
            {live ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button className="icon-button" onClick={() => void runSearch()} title="Run query">
            <RefreshCcw size={16} />
          </button>
        </div>
      </header>

      <section className="global-query">
        <div className="query-line">
          <Search size={18} />
          <input
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
            aria-label="LogsQL query"
            placeholder="Filter your logs. Press Space to search using natural language queries."
          />
          <button className="add-button" onClick={() => void runSearch()}>Add</button>
        </div>
        {appliedFilters.length > 0 && (
          <div className="active-filters query-active-filters" aria-label="Active filters">
            {appliedFilters.map((filter) => (
              <button key={`${filter.field}:${filter.value}`} onClick={() => removeFilter(filter)}>
                <X size={12} />
                <span>{filter.field}:{filter.value}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <aside className="facets">
        <div className="facet-search">
          <Search size={15} />
          <input
            value={facetSearch}
            onChange={(event) => setFacetSearch(event.target.value)}
            placeholder="Search facets"
            aria-label="Search facets"
          />
        </div>

        <div className="facet-summary">
          <span>Showing {visibleFacetDefinitions.length} of {facetDefinitions.length}</span>
        </div>

        <section className="filter-panel">
          <div className="facet-category">Core</div>
          <div className="manual-filter">
            <select value={manualField} onChange={(event) => setManualField(event.target.value)} aria-label="Filter field">
              {fields.map((field) => <option key={field} value={field}>{field}</option>)}
            </select>
            <input
              ref={manualValueRef}
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submitManualFilter();
                }
              }}
              placeholder="value"
              aria-label="Filter value"
            />
            <button
              title="Apply filter"
              onClick={submitManualFilter}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="facet-list">
            {visibleFacetDefinitions.map(({ field, label }) => {
              const values = visibleValuesForField(field, label);
              if (values.length === 0) return null;
              return (
                <details key={field} open={Boolean(facetSearch.trim()) || ["environment", "service", "host", "level"].includes(field)}>
                  <summary>
                    <span>{label}</span>
                    <CheckCircle2 size={13} />
                  </summary>
                  {values.slice(0, 10).map((item) => (
                    <button key={`${field}-${item.value}`} onClick={() => toggleFilter(field, item.value)}>
                      <input type="checkbox" checked={appliedFilters.some((filter) => filter.field === field && filter.value === item.value)} readOnly />
                      <i className={`facet-swatch ${field === "level" ? item.value.toLowerCase() : ""}`} />
                      <span>{item.value}</span>
                      <em>{item.hits}</em>
                    </button>
                  ))}
                </details>
              );
            })}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <section className="ai-row">
          <Bot size={17} />
          <input
            value={aiPrompt}
            onChange={(event) => setAiPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void askAi();
            }}
            placeholder="Describe the logs you want"
          />
          <button onClick={() => void askAi()} disabled={!aiPrompt.trim() || loading}>
            <Sparkles size={16} />
            <span>Analyze</span>
          </button>
        </section>

        <section className={`stream-status ${liveStatus}`}>
          {liveStatus === "streaming" ? <CheckCircle2 size={15} /> : <Filter size={15} />}
          <span>
            {liveStatus === "off" && "Live tail: off"}
            {liveStatus === "connecting" && "Live tail: connecting"}
            {liveStatus === "streaming" && "Live tail: streaming"}
            {liveStatus === "reconnecting" && "Live tail: reconnecting"}
            {liveStatus === "error" && "Live tail: disconnected"}
          </span>
        </section>

        {aiExplanation && (
          <div className="notice">
            {aiExplanation}
            {aiRelaxations.length > 0 && (
              <div className="notice-relax">
                No matches for the AI's original query — broadened {aiRelaxations.length} time{aiRelaxations.length === 1 ? "" : "s"} to <code>{aiRelaxations[aiRelaxations.length - 1] || "_time:15m"}</code>.
              </div>
            )}
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}

        <section className="histogram" aria-label="Log volume histogram">
          {histogram.map((bar) => (
            <span key={bar.key} className="hbar" style={{ height: `${bar.height}px` }} title={`${bar.total} logs`}>
              {bar.error > 0 && <i className="seg error" style={{ flexBasis: `${bar.error}%` }} />}
              {bar.warning > 0 && <i className="seg warning" style={{ flexBasis: `${bar.warning}%` }} />}
              {bar.info > 0 && <i className="seg info" style={{ flexBasis: `${bar.info}%` }} />}
              {bar.other > 0 && <i className="seg other" style={{ flexBasis: `${bar.other}%` }} />}
            </span>
          ))}
        </section>

        <section className="log-table" style={logColumns.style}>
          <div className="log-card-head">
            <div className="log-card-title">
              <strong>{totalLogsDisplay} logs</strong>
              <span>{loading ? "Loading" : query}</span>
            </div>
            <button className="log-card-action" onClick={downloadRows}>
              <Download size={14} /> Download CSV
            </button>
          </div>
          <div className="log-header">
            {logColumns.columns.map((column) => <span key={column.key}>{column.label}</span>)}
          </div>
          {rows.map((row, index) => (
            <div
              key={`${timeValue(row)}-${index}`}
              role="button"
              tabIndex={0}
              onClick={() => selectLogEvent(row)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") selectLogEvent(row);
              }}
              className={`log-row sev-${severityKey(levelValue(row))} ${selected === row ? "selected" : ""}`}
            >
              {logColumns.columns.map((column) => <React.Fragment key={column.key}>{renderLogCell(column.key, row)}</React.Fragment>)}
            </div>
          ))}
        </section>
      </main>

      {selected && (
        <div className="event-overlay" role="dialog" aria-modal="true" aria-label="Log event" onMouseDown={() => clearSelectedLogEvent()}>
          <aside className="event-panel" onMouseDown={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <div>
                <strong>Log event</strong>
                <span title={timeValue(selected)}>{localTimeValue(selected)}</span>
              </div>
              <button onClick={() => clearSelectedLogEvent()} title="Close"><X size={17} /></button>
            </div>
            <p>{message(selected)}</p>
            <div className="field-grid">
              {Object.entries(selected)
                .filter(([, value]) => asText(value))
                .map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <code>{asText(value)}</code>
                    <button title="Add filter" onClick={() => applyFilter(key, asText(value))}>
                      <Plus size={13} />
                    </button>
                  </div>
                ))}
            </div>
          </aside>
        </div>
      )}

    </div>

    {mode === "welcome" && (
      <div className="welcome" role="dialog" aria-label="Ask Hikari">
        <div className="welcome-constellation" ref={constellationRef} aria-hidden="true" />
        <header className="welcome-chrome">
          <div className="product">
            <div className="mark" aria-label="Hikari"><HikariSparkle size={20} /></div>
            <div>
              <strong>Hikari</strong>
              <span>Log analysis system</span>
            </div>
          </div>
          <button className="welcome-skip" onClick={() => setMode("explore")}>
            Browse all logs
            <ArrowRight size={14} />
          </button>
        </header>

        <div className="welcome-card">
          <div className="welcome-watermark" aria-hidden="true">
            <HikariSparkle size={320} glow={false} />
          </div>
          <h1 className="welcome-title">Shine a light on your logs.</h1>
          <p className="welcome-sub">
            Describe what you're looking for in plain English — Hikari turns it into a query and surfaces what matters.
          </p>

          <div className="welcome-input">
            <Sparkles size={18} />
            <input
              autoFocus
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void askAi();
              }}
              placeholder="e.g. authentication failures from the last hour"
              aria-label="Ask in natural language"
            />
            <button
              className="welcome-go"
              onClick={() => void askAi()}
              disabled={!aiPrompt.trim() || loading}
              title="Run"
            >
              <ArrowRight size={18} />
            </button>
          </div>

          <div className="welcome-suggestions" role="list" aria-label="Trending in your data">
            <div className="welcome-suggestions-label">Trending in your data</div>
            {trendingSuggestions.map((suggestion) => (
              <button
                key={suggestion.text}
                className={`tone-${suggestion.tone}`}
                onClick={() => runSuggestion(suggestion.text)}
                disabled={loading}
              >
                <i className="suggestion-dot" aria-hidden="true" />
                {suggestion.text}
              </button>
            ))}
          </div>

          <div className="welcome-stats">
            <span className={`mood-badge mood-${mood.label}`} title={`Ambient is ${mood.label}`}>
              <i className="mood-pulse" aria-hidden="true" />
              {mood.label}
            </span>
            <span><strong>{totalLogsDisplay}</strong> logs · last 15 min</span>
            <span className="dot error">{severityCounts.error.toLocaleString()} errors</span>
            <span className="dot warning">{severityCounts.warning.toLocaleString()} warnings</span>
            <span className="dot info">{severityCounts.info.toLocaleString()} info</span>
          </div>
        </div>
      </div>
    )}

    {mode === "answer" && !aiModalOpen && (
      <div className="answer" role="region" aria-label="AI response">
        <header className="answer-chrome">
          <div className="product">
            <div className="mark" aria-label="Hikari"><HikariSparkle size={20} /></div>
            <div>
              <strong>Hikari</strong>
              <span>AI response</span>
            </div>
          </div>
          <div className="answer-chrome-actions">
            <button className="answer-action-secondary" onClick={() => setMode("welcome")}>
              <Sparkles size={14} />
              Ask another
            </button>
            <button className="answer-action-primary" onClick={() => setMode("explore")}>
              Browse all {totalLogsDisplay} logs
              <ArrowRight size={14} />
            </button>
          </div>
        </header>

        <div className="answer-body">
          <div className="answer-card">
            <div className="answer-question">
              <span className="answer-section-label">You asked</span>
              <h2>{aiPrompt || "—"}</h2>
            </div>

            <div className="answer-found">
              <div className="answer-found-head">
                <div className="answer-found-orb">
                  <Sparkles size={18} />
                </div>
                <div>
                  <span className="answer-section-label">Hikari found</span>
                  <p className="answer-found-headline">
                    {findings.length > 0
                      ? `${totalLogsDisplay} matching events. Here's what stands out:`
                      : `No matching events for this question yet.`}
                  </p>
                </div>
              </div>

              {findings.length > 0 && (
                <ul className="answer-findings-list">
                  {findings.map((finding, idx) => (
                    <li key={`finding-${idx}`}>
                      {renderWithEntities(finding, entityMap, handleEntityClick)}
                    </li>
                  ))}
                </ul>
              )}

              <div className="answer-stats">
                <span><strong>{totalLogsDisplay}</strong> matching logs</span>
                <span className="dot error">{severityCounts.error.toLocaleString()} errors</span>
                <span className="dot warning">{severityCounts.warning.toLocaleString()} warnings</span>
                <span className="dot info">{severityCounts.info.toLocaleString()} info</span>
              </div>
            </div>

            <div className="answer-method">
              <div className="answer-method-head">
                <span className="answer-section-label">How Hikari investigated</span>
              </div>

              <div className="answer-method-body">
                {aiExplanation && (
                  <div className="answer-method-block">
                    <span className="answer-method-label">Approach</span>
                    <div className="answer-summary-prose">
                      {aiExplanation.split(/\n{2,}/).filter(Boolean).map((para, idx) => (
                        <p key={`para-${idx}`}>{renderWithEntities(para, entityMap, handleEntityClick)}</p>
                      ))}
                    </div>
                  </div>
                )}

                {aiEvidence.length > 0 && (
                  <div className="answer-method-block">
                    <span className="answer-method-label">Evidence in data</span>
                    <ul className="answer-evidence-list">
                      {aiEvidence.map((item, idx) => (
                        <li key={`ev-${idx}`}>
                          {renderWithEntities(item, entityMap, handleEntityClick)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {aiRelaxations.length > 0 && (
                  <div className="answer-method-block">
                    <span className="answer-method-label">Search adjustments</span>
                    <p className="answer-relax-intro">
                      No matches for the original query — Hikari broadened the search {aiRelaxations.length} time{aiRelaxations.length === 1 ? "" : "s"} to find related activity.
                    </p>
                    <ol className="answer-relax-list">
                      {aiRelaxations.map((q, idx) => (
                        <li key={`relax-${idx}`}><code>{q || "_time:15m"}</code></li>
                      ))}
                    </ol>
                  </div>
                )}

                <div className="answer-method-block">
                  <span className="answer-method-label">Generated query</span>
                  <code className="answer-query-code">{query}</code>
                </div>
              </div>
            </div>

            <div className="answer-samples">
              <div className="answer-samples-head">
                <span className="answer-section-label">
                  {answerSamples.fallback ? "Related recent logs" : "Sample matches"}
                </span>
                {!answerSamples.fallback && (
                  <span className="answer-samples-meta">showing first {answerSamples.rows.length} of {totalLogsDisplay}</span>
                )}
                {answerSamples.fallback && answerSamples.rows.length > 0 && (
                  <span className="answer-samples-meta">
                    {answerSamples.targetService
                      ? `no exact matches · showing recent ${answerSamples.targetService}`
                      : `no exact matches · showing recent activity`}
                  </span>
                )}
              </div>
              {answerSamples.rows.length === 0 ? (
                <div className="answer-empty">Nothing in the live tail buffer yet — try a broader prompt.</div>
              ) : (
                <div className="answer-samples-list">
                  {answerSamples.rows.map((row, index) => {
                    const level = levelValue(row);
                    const sev = severityKey(level);
                    return (
                      <button
                        key={`answer-sample-${index}`}
                        className={`answer-sample sev-${sev}`}
                        onClick={() => selectLogEvent(row)}
                      >
                        <span className={`level-badge ${sev}`} title={level}>{levelLabel(level)}</span>
                        <time className="answer-sample-time">{localTimeValue(row).split("  ")[1] ?? ""}</time>
                        <span className="answer-sample-service">{serviceValue(row) || envValue(row) || "log"}</span>
                        <span className="answer-sample-msg">{message(row)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )}

      {aiModalOpen && (
        <div className="ai-overlay" role="dialog" aria-modal="true" aria-label="AI investigation">
          <section className="ai-modal">
            <header className="ai-modal-head">
              <div className="ai-modal-title">
                <div className={`ai-orb ${aiRunning ? "running" : "done"}`}>
                  {aiRunning ? <Sparkles size={18} /> : <CheckCircle2 size={18} />}
                </div>
                <div>
                  <strong>{aiRunning ? "Investigating your prompt" : "Investigation complete"}</strong>
                  <span>{aiRunning ? "Reading the data and building your query…" : "Query ready — opening results"}</span>
                </div>
              </div>
              <button onClick={() => setAiModalOpen(false)} disabled={aiRunning} title="Close">
                <X size={17} />
              </button>
            </header>

            {aiPrompt && (
              <div className="ai-prompt-echo">
                <span className="ai-prompt-mark" aria-hidden="true">"</span>
                <span className="ai-prompt-text">{aiPrompt}</span>
              </div>
            )}

            <div className="ai-step-list">
              {aiSteps.map((step, index) => {
                const isLast = index === aiSteps.length - 1;
                return (
                  <article key={`${step.title}-${index}`} className={`ai-step ${step.status}`}>
                    <div className="ai-step-rail">
                      <div className="ai-step-icon" aria-hidden="true">
                        {step.status === "done" && <CheckCircle2 size={13} />}
                        {step.status === "error" && <X size={13} />}
                        {step.status === "running" && <span className="ai-step-dot" />}
                      </div>
                      {!isLast && <div className="ai-step-line" />}
                    </div>
                    <div className="ai-step-body">
                      <div className="ai-step-title">
                        <strong>{step.title}</strong>
                        {step.tool && <code>{step.tool}</code>}
                      </div>
                      {step.detail && <p>{step.detail}</p>}
                      {step.items && step.items.length > 0 && (
                        <ul>
                          {step.items.slice(0, 6).map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
