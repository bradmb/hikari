import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Filter,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
  X
} from "lucide-react";
import { generateQuery, getAppConfig, getFacets, getFieldValues, getFields, getHits, searchLogs, tailUrl, type AiConversationMessage, type AiIncidentContext, type AiStep, type DerivedFieldRule, type FacetsResponse, type FieldMappings, type HitBucket, type HitsResponse, type LogRow, type QueryWindow, type ValueHit } from "./api";
import "./styles.css";

const emptyFieldMappings: FieldMappings = { defaultFields: [], aliases: {}, facets: [], derivedFields: {} };
let activeFieldMappings = emptyFieldMappings;

function setActiveFieldMappings(next: FieldMappings) {
  activeFieldMappings = next;
}

const aiProgressTemplate: AiStep[] = [
  {
    title: "Preparing investigation",
    status: "pending",
    detail: "Reading your prompt and the current LogsQL query."
  },
  {
    title: "Scanning field values",
    status: "pending",
    detail: "Looking across service, host, environment, level, source, and Kubernetes fields."
  },
  {
    title: "Sampling log rows",
    status: "pending",
    detail: "Checking recent events to find how the thing you named is represented in real logs."
  },
  {
    title: "Asking AI to map the data",
    status: "pending",
    detail: "Turning observed values into an editable LogsQL query."
  },
  {
    title: "Testing and normalizing query",
    status: "pending",
    detail: "Expanding level variants and cleaning up the final query."
  }
];

type AppliedFilter = {
  field: string;
  value: string;
  token: string;
  exclude?: boolean;
};

type ViewMode = "welcome" | "answer" | "explore";

const defaultLogQuery = "_time:15m";
const timePresets = [
  { label: "Past 15 Minutes", shortLabel: "15m", query: "_time:15m" },
  { label: "Past 30 Minutes", shortLabel: "30m", query: "_time:30m" },
  { label: "Past 1 Hour", shortLabel: "1h", query: "_time:1h" },
  { label: "Past 4 Hours", shortLabel: "4h", query: "_time:4h" },
  { label: "Past 12 Hours", shortLabel: "12h", query: "_time:12h" },
  { label: "Past 24 Hours", shortLabel: "24h", query: "_time:24h" }
];
const logQueryParam = "q";
const facetParam = "facet";
const startParam = "start";
const endParam = "end";
const selectedEventParam = "event";
const selectedEventStoragePrefix = "hikari:selected-event:";
const timeFilterPattern = /\b_time:(?:\[[^\]\)]*[\]\)]|day_range[\[\(][^\]\)]*[\]\)]|week_range[\[\(][^\]\)]*[\]\)]|[^\s)]+)/;

function modeFromPath(pathname: string): ViewMode {
  return pathname === "/browse" ? "explore" : "welcome";
}

function selectedEventIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get(selectedEventParam);
}

function logQueryFromUrl(): string {
  return new URLSearchParams(window.location.search).get(logQueryParam)?.trim() || defaultLogQuery;
}

function cleanTimeParam(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function timeWindowFromUrl(): QueryWindow {
  const params = new URLSearchParams(window.location.search);
  return {
    start: cleanTimeParam(params.get(startParam)),
    end: cleanTimeParam(params.get(endParam))
  };
}

function hasTimeWindow(window: QueryWindow): boolean {
  return Boolean(window.start && window.end);
}

function serializeFacet(filter: Pick<AppliedFilter, "field" | "value" | "exclude">): string {
  return `${filter.exclude ? "-" : ""}${filter.field}:${filter.value}`;
}

function parseFacet(value: string): AppliedFilter | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const rawField = value.slice(0, separator).trim();
  const exclude = rawField.startsWith("-");
  const field = (exclude ? rawField.slice(1) : rawField).trim();
  const rawValue = value.slice(separator + 1).trim();
  if (!field || !rawValue) return null;
  return { field, value: displayFacetValue(field, rawValue), token: "", exclude };
}

function facetsFromUrl(): AppliedFilter[] {
  const seen = new Set<string>();
  return new URLSearchParams(window.location.search).getAll(facetParam).flatMap((value) => {
    const facet = parseFacet(value);
    if (!facet) return [];
    const key = serializeFacet(facet);
    if (seen.has(key)) return [];
    seen.add(key);
    return [facet];
  });
}

function logStateFromUrl() {
  const urlQuery = logQueryFromUrl();
  const urlFacets = facetsFromUrl();
  const window = timeWindowFromUrl();
  if (urlFacets.length === 0) return { query: urlQuery, filters: [] as AppliedFilter[], window };
  const next = buildQueryWithFilters(urlQuery, [], urlFacets);
  return { query: next.query, filters: next.filters, window };
}

function stableLogJson(row: LogRow): string {
  const sorted: LogRow = {};
  Object.keys(row).sort().forEach((key) => {
    sorted[key] = row[key];
  });
  return JSON.stringify(sorted);
}

function prettyLogJson(row: LogRow): string {
  return JSON.stringify(JSON.parse(stableLogJson(row)), null, 2);
}

function promptForLogEvent(row: LogRow): string {
  return [
    "Investigate this error. Identify the likely cause, affected component, impact, and the next concrete debugging steps.",
    "",
    "Full log event JSON:",
    "```json",
    prettyLogJson(row),
    "```"
  ].join("\n");
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
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

function buildAppUrl(
  mode: ViewMode,
  eventId?: string | null,
  logQuery?: string | null,
  filters: Pick<AppliedFilter, "field" | "value" | "exclude">[] = [],
  queryWindow: QueryWindow = {}
): string {
  const params = new URLSearchParams(window.location.search);
  const cleanQuery = (logQuery ?? params.get(logQueryParam) ?? "").trim();
  if (mode === "explore" && cleanQuery && cleanQuery !== defaultLogQuery) {
    params.set(logQueryParam, cleanQuery);
  } else {
    params.delete(logQueryParam);
  }
  params.delete(facetParam);
  if (mode === "explore") {
    filters.forEach((filter) => {
      if (filter.field.trim() && filter.value.trim()) params.append(facetParam, serializeFacet(filter));
    });
  }
  params.delete(startParam);
  params.delete(endParam);
  if (mode === "explore" && queryWindow.start && queryWindow.end) {
    params.set(startParam, queryWindow.start);
    params.set(endParam, queryWindow.end);
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

type SeverityCounts = {
  error: number;
  warning: number;
  info: number;
  debug: number;
  other: number;
};

type SeverityStats = {
  counts: SeverityCounts;
  classifiedTotal: number;
  source: "facet" | "rows";
};

type HistogramSeverity = "error" | "warning" | "info" | "debug";

type HistogramSeveritySeries = Record<HistogramSeverity, HitBucket[]>;

function emptySeverityCounts(): SeverityCounts {
  return { error: 0, warning: 0, info: 0, debug: 0, other: 0 };
}

function severityCountsFromRows(rows: LogRow[]): SeverityCounts {
  const counts = emptySeverityCounts();
  rows.forEach((row) => {
    counts[severityKey(levelValue(row))] += 1;
  });
  return counts;
}

function deriveMood(rows: LogRow[]): Mood {
  if (rows.length < 5) {
    return { hue: 188, saturation: 48, intensity: 0.35, label: "calm" };
  }
  const total = rows.length;
  const counts = severityCountsFromRows(rows);
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

function parseJsonPayload(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function messageFromPayload(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  return asText(payload.msg ?? payload.message ?? payload.Message ?? payload.State ?? payload.state ?? payload.event);
}

function message(row: LogRow): string {
  const candidates = [row.message, row.msg, row._msg, row.log];
  for (const candidate of candidates) {
    const raw = asText(candidate);
    if (!raw) continue;
    const nested = messageFromPayload(parseJsonPayload(raw));
    if (nested) return nested;
    return raw;
  }
  return "";
}

function ruleSources(rule: DerivedFieldRule): string[] {
  const configured = Array.isArray(rule.sources) ? rule.sources : rule.source ? [rule.source] : [];
  return configured.map((source) => source.trim()).filter(Boolean);
}

function jsonPathValue(value: unknown, path = ""): unknown {
  let current = value;
  if (typeof current === "string") {
    const raw = current.trim();
    if (!raw.startsWith("{")) return undefined;
    try {
      current = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!path) return current;
  for (const part of path.split(".")) {
    if (!part || !current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function regexMatches(pattern: string, value: string, flags = ""): boolean {
  try {
    return new RegExp(pattern, flags.replace(/[^dgimsuvy]/g, "")).test(value);
  } catch {
    return false;
  }
}

function derivedFieldValue(row: LogRow, field: string): string {
  const rules = activeFieldMappings.derivedFields?.[field] ?? [];
  for (const rule of rules) {
    for (const source of ruleSources(rule)) {
      const raw = row[source];
      if (raw === undefined || raw === null || asText(raw) === "") continue;
      if (rule.type === "json") {
        const derived = jsonPathValue(raw, rule.path);
        const value = asText(derived);
        if (value) return field === "level" ? canonicalLevel(value) : value;
      }
      if (rule.type === "regex" && rule.pattern && rule.value && regexMatches(rule.pattern, asText(raw), rule.flags)) {
        return field === "level" ? canonicalLevel(rule.value) : rule.value;
      }
    }
  }
  return "";
}

function levelFromMessageFields(row: LogRow): string {
  return derivedFieldValue(row, "level");
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

function formatChartTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatBucketTime(timestamp: number, stepMs: number): string {
  const options: Intl.DateTimeFormatOptions = stepMs >= 24 * 60 * 60 * 1000
    ? { month: "short", day: "numeric" }
    : stepMs >= 60 * 60 * 1000
      ? { month: "short", day: "numeric", hour: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" };
  return new Date(timestamp).toLocaleString([], options);
}

function formatTimeWindow(window: QueryWindow): string {
  if (!window.start || !window.end) return "";
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return `${formatChartTime(start)} to ${formatChartTime(end)}`;
}

function parseTimeRangeToken(token: string): { start: number; end: number } | null {
  const match = token.match(/^_time:\[([^,\]]+),\s*([^\]\)]+)[\]\)]$/);
  if (!match) return null;
  const start = Date.parse(normalizeIsoTimestamp(match[1].trim()));
  const end = Date.parse(normalizeIsoTimestamp(match[2].trim()));
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return { start, end };
}

function formatTimeTokenLabel(token: string): { label: string; shortLabel: string; query: string } {
  const range = parseTimeRangeToken(token);
  if (range) {
    return {
      label: `${formatChartTime(range.start)} to ${formatChartTime(range.end)}`,
      shortLabel: "range",
      query: token
    };
  }
  return { label: token, shortLabel: token.replace("_time:", ""), query: token };
}

function parseDurationMs(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };
  return amount * unitMs[unit];
}

function durationToken(ms: number): string {
  if (ms < 60 * 1000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  if (minutes % (7 * 24 * 60) === 0) return `${minutes / (7 * 24 * 60)}w`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function timeRangeForQuery(query: string, window: QueryWindow): { start: number; end: number } {
  const windowStart = window.start ? Date.parse(window.start) : NaN;
  const windowEnd = window.end ? Date.parse(window.end) : NaN;
  if (!Number.isNaN(windowStart) && !Number.isNaN(windowEnd) && windowEnd > windowStart) {
    return { start: windowStart, end: windowEnd };
  }
  const token = timeToken(query);
  const tokenRange = parseTimeRangeToken(token);
  if (tokenRange) return tokenRange;
  const duration = parseDurationMs(token.replace("_time:", "")) ?? 15 * 60 * 1000;
  const end = Date.now();
  return { start: end - duration, end };
}

function histogramStepMs(query: string, window: QueryWindow): number {
  const range = timeRangeForQuery(query, window);
  const span = Math.max(60 * 1000, range.end - range.start);
  return Math.max(1000, Math.ceil(span / 180));
}

function hitTimestamp(hit: Record<string, unknown>): number {
  const raw = hit.timestamp ?? hit.time ?? hit._time;
  if (typeof raw === "number") return raw > 100000000000 ? raw : raw * 1000;
  if (typeof raw === "string") {
    const parsed = Date.parse(normalizeIsoTimestamp(raw));
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
}

function normalizeHitBuckets(result: HitsResponse): HitBucket[] {
  if (Array.isArray(result.values)) return result.values;
  return (result.hits ?? []).flatMap((series) => {
    const timestamps = series.timestamps ?? [];
    const values = series.values ?? [];
    return timestamps.map((timestamp, index) => ({
      ...(series.fields ?? {}),
      timestamp,
      hits: values[index] ?? 0
    }));
  });
}

/** Extract a value from Promise.allSettled without making optional telemetry requests fatal. */
function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

function isValueHit(value: unknown): value is ValueHit {
  return Boolean(
    value &&
    typeof value === "object" &&
    "value" in value &&
    typeof (value as { value?: unknown }).value === "string"
  );
}

/** Normalize supported VictoriaLogs facet response shapes into the UI's field-to-values map. */
function normalizeFacetResponse(result: FacetsResponse): Record<string, ValueHit[]> {
  const out: Record<string, ValueHit[]> = {};
  if (result.values && typeof result.values === "object") {
    Object.entries(result.values).forEach(([field, values]) => {
      if (Array.isArray(values)) out[field] = values.filter(isValueHit);
    });
  }
  if (Array.isArray(result.facets)) {
    result.facets.forEach((facet) => {
      if (facet.field && Array.isArray(facet.values)) out[facet.field] = facet.values.filter(isValueHit);
    });
  }
  return out;
}

function timeToken(query: string): string {
  return query.match(timeFilterPattern)?.[0] ?? defaultLogQuery;
}

function replaceTimeToken(query: string, token: string): string {
  const trimmed = query.trim();
  if (!trimmed) return token;
  if (timeFilterPattern.test(trimmed)) return trimmed.replace(timeFilterPattern, token);
  return `${token} ${trimmed}`;
}

function logsQlTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function timeRangeToken(window: QueryWindow): string {
  if (!window.start || !window.end) return defaultLogQuery;
  return `_time:[${logsQlTime(window.start)}, ${logsQlTime(window.end)})`;
}

function presetForQuery(query: string) {
  const token = timeToken(query);
  return timePresets.find((preset) => preset.query === token) ?? formatTimeTokenLabel(token);
}

function toDatetimeLocal(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function datetimeLocalToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function defaultCustomWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 15 * 60 * 1000);
  return { start: toDatetimeLocal(start.toISOString()), end: toDatetimeLocal(end.toISOString()) };
}

function rowTimestamp(row: LogRow): number {
  const raw = timeValue(row);
  if (!raw) return NaN;
  return new Date(normalizeIsoTimestamp(raw)).getTime();
}

function rowsNewestFirst(rows: LogRow[]): LogRow[] {
  return [...rows].sort((left, right) => {
    const leftTime = rowTimestamp(left);
    const rightTime = rowTimestamp(right);
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    return rightTime - leftTime;
  });
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
  return firstFieldValue(row, aliasFieldsForFilter("level")) || levelFromMessageFields(row) || "unknown";
}

function fieldValue(row: LogRow, field: string): string {
  const aliases = aliasFieldsForFilter(field);
  if (aliases.length > 1 || field in activeFieldMappings.aliases) return firstFieldValue(row, aliases);
  return asText(row[field]);
}

function envValue(row: LogRow): string {
  return firstFieldValue(row, aliasFieldsForFilter("environment"));
}

function hostValue(row: LogRow): string {
  return firstFieldValue(row, aliasFieldsForFilter("host"));
}

function serviceValue(row: LogRow): string {
  return firstFieldValue(row, aliasFieldsForFilter("service"));
}

function countFromHit(hit: Record<string, unknown>): number {
  const value = hit.hits ?? hit.count ?? hit.logs ?? 0;
  return typeof value === "number" ? value : Number(value) || 0;
}

function quoteValue(value: string): string {
  return JSON.stringify(value);
}

/** Add a severity classifier clause used only for histogram level breakdown requests. */
function queryWithLevelBucket(query: string, severity: HistogramSeverity): string {
  return `${query.trim() || defaultLogQuery} (${levelSearchClauses(severity).join(" OR ")})`;
}

function levelSearchClauses(value: string): string[] {
  const severity = severityKey(value);
  const variants: Record<HistogramSeverity, string[]> = {
    error: ["error", "Error", "ERROR", "err", "fatal", "critical"],
    warning: ["warning", "Warning", "WARN", "warn"],
    info: ["info", "Info", "INFO", "information", "Information"],
    debug: ["debug", "Debug", "DEBUG", "trace", "Trace", "verbose", "Verbose"]
  };
  if (severity === "other") return [filterToken("level", value)];
  const fields = Array.from(new Set([...aliasFieldsForFilter("level"), "level", "severity_text", "severity", "Level"]));
  return Array.from(
    new Set([
      ...fields.flatMap((field) => variants[severity].map((value) => `${field}:${quoteValue(value)}`)),
      ...derivedRegexClauses("level", severity)
    ])
  );
}

function derivedRegexClauses(field: string, severity: HistogramSeverity): string[] {
  const rules = activeFieldMappings.derivedFields?.[field] ?? [];
  return rules.flatMap((rule) => {
    if (rule.type !== "regex" || !rule.pattern || !rule.value || severityKey(rule.value) !== severity) return [];
    const configuredPattern = rule.queryPattern || rule.pattern;
    const pattern = rule.flags?.includes("i") && !configuredPattern.startsWith("(?i)") ? `(?i)${configuredPattern}` : configuredPattern;
    return ruleSources(rule).map((source) => `${source}:~${quoteValue(pattern)}`);
  });
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

/** Resolve a canonical facet name to every configured source field that can carry the same value. */
function aliasFieldsForFilter(field: string): string[] {
  const mapped = activeFieldMappings.aliases[field]?.map((item) => item.trim()).filter(Boolean) ?? [];
  return mapped.length > 0 ? mapped : [field];
}

function filterToken(field: string, value: string): string {
  const cleanValue = value.trim();
  if (!field || !cleanValue) return "";
  return `${field}:=${quoteValue(cleanValue)}`;
}

function negateToken(token: string): string {
  if (!token) return "";
  return token.startsWith("(") ? `NOT ${token}` : `NOT ${token}`;
}

function expandedFilterToken(field: string, value: string): string {
  const cleanValue = value.trim();
  if (!field || !cleanValue) return "";
  if (field === "level") {
    return `(${levelSearchClauses(cleanValue).join(" OR ")})`;
  }
  const fields = aliasFieldsForFilter(field);
  if (fields.length > 1) {
    return `(${fields.map((alias) => `${alias}:=${quoteValue(cleanValue)}`).join(" OR ")})`;
  }
  return `${fields[0]}:=${quoteValue(cleanValue)}`;
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
  return `(${cleanValues.map((value) => filterToken(field, value)).join(" OR ")})`;
}

function negativeFilterTokenForValues(field: string, values: string[]): string {
  return negateToken(filterTokenForValues(field, values));
}

function expandedFilterTokenForValues(field: string, values: string[]): string {
  const cleanValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  if (cleanValues.length === 0) return "";
  if (cleanValues.length === 1) return expandedFilterToken(field, cleanValues[0]);
  const tokens = cleanValues.map((value) => {
    if (field === "level") {
      return levelSearchClauses(value);
    }
    return aliasFieldsForFilter(field).map((alias) => `${alias}:=${quoteValue(value)}`);
  }).flat();
  return `(${Array.from(new Set(tokens)).join(" OR ")})`;
}

function expandedNegativeFilterTokenForValues(field: string, values: string[]): string {
  return negateToken(expandedFilterTokenForValues(field, values));
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
    const key = `${filter.exclude ? "exclude" : "include"}:${filter.field}`;
    const group = grouped.get(key) ?? [];
    group.push(filter);
    grouped.set(key, group);
  });

  const filtersWithTokens: AppliedFilter[] = [];
  grouped.forEach((group) => {
    const field = group[0]?.field ?? "";
    const exclude = Boolean(group[0]?.exclude);
    const token = exclude
      ? negativeFilterTokenForValues(field, group.map((filter) => filter.value))
      : filterTokenForValues(field, group.map((filter) => filter.value));
    if (!token) return;
    nextQuery = addFilterToQuery(nextQuery, token);
    group.forEach((filter) => filtersWithTokens.push({ ...filter, token }));
  });

  return { query: nextQuery, filters: filtersWithTokens };
}

/** Build backend-only LogsQL that expands visible canonical facet filters across all aliases. */
function queryWithExpandedFilters(query: string, filters: AppliedFilter[]): string {
  if (filters.length === 0) return query;
  let nextQuery = stripAppliedFilterTokens(query, filters);
  const grouped = new Map<string, AppliedFilter[]>();
  filters.forEach((filter) => {
    const key = `${filter.exclude ? "exclude" : "include"}:${filter.field}`;
    const group = grouped.get(key) ?? [];
    group.push(filter);
    grouped.set(key, group);
  });

  grouped.forEach((group) => {
    const field = group[0]?.field ?? "";
    const exclude = Boolean(group[0]?.exclude);
    const token = exclude
      ? expandedNegativeFilterTokenForValues(field, group.map((filter) => filter.value))
      : expandedFilterTokenForValues(field, group.map((filter) => filter.value));
    if (token) nextQuery = addFilterToQuery(nextQuery, token);
  });
  return nextQuery;
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

function inlineFormat(segment: string, keyPrefix = "fmt"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|"([^"]+)"/g;
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    if (match.index > cursor) out.push(segment.slice(cursor, match.index));
    if (match[1] !== undefined) {
      out.push(<strong key={`${keyPrefix}-${key++}`}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      out.push(<code key={`${keyPrefix}-${key++}`}>{match[2]}</code>);
    } else if (match[3] !== undefined) {
      out.push(<q key={`${keyPrefix}-${key++}`}>{match[3]}</q>);
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
    if (m.start > cursor) parts.push(...inlineFormat(text.slice(cursor, m.start), `fmt-${cursor}`));
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
  if (cursor < text.length) parts.push(...inlineFormat(text.slice(cursor), `fmt-${cursor}`));
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

function buildFindings(rows: LogRow[], totalMatches = rows.length): string[] {
  if (rows.length === 0) return [];
  const findings: string[] = [];
  const sampleLabel = totalMatches > rows.length ? "sampled matches" : "matches";

  const counts = { error: 0, warning: 0, info: 0, debug: 0, other: 0 };
  rows.forEach((row) => {
    counts[severityKey(levelValue(row))] += 1;
  });
  const errorPct = Math.round((counts.error / rows.length) * 100);
  if (counts.error > 0) {
    findings.push(`**${counts.error}** of ${rows.length} ${sampleLabel} are errors (${errorPct}%); ${counts.warning} warnings, ${counts.info} info.`);
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

function compactIncidentRow(row: LogRow): LogRow {
  const keys = [
    "_time",
    "level",
    "service",
    "host",
    "environment",
    "status",
    "_msg",
    "message",
    "msg",
    "kubernetes.pod_namespace",
    "kubernetes.pod_name",
    "kubernetes.container_name"
  ];
  const compact: LogRow = {};
  keys.forEach((key) => {
    const value = row[key];
    if (value !== undefined && value !== null && String(value) !== "") compact[key] = value;
  });
  return compact;
}

function App() {
  const initialLogState = logStateFromUrl();
  const [query, setQuery] = useState(initialLogState.query);
  const [draftQuery, setDraftQuery] = useState(initialLogState.query);
  const [timeWindow, setTimeWindow] = useState<QueryWindow>(initialLogState.window);
  const [aiPrompt, setAiPrompt] = useState("");
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [aiConversation, setAiConversation] = useState<AiConversationMessage[]>([]);
  const [followUpThinking, setFollowUpThinking] = useState(false);
  const [aiExplanation, setAiExplanation] = useState("");
  const [aiEvidence, setAiEvidence] = useState<string[]>([]);
  const [aiRelaxations, setAiRelaxations] = useState<string[]>([]);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [hits, setHits] = useState<HitBucket[]>([]);
  const [histogramLevelHits, setHistogramLevelHits] = useState<HistogramSeveritySeries>({
    error: [],
    warning: [],
    info: [],
    debug: []
  });
  const [hitStepMs, setHitStepMs] = useState(histogramStepMs(initialLogState.query, initialLogState.window));
  const [hitRange, setHitRange] = useState(() => timeRangeForQuery(initialLogState.query, initialLogState.window));
  const [fieldMappings, setFieldMappings] = useState<FieldMappings>(emptyFieldMappings);
  const [configReady, setConfigReady] = useState(false);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [facetPreviewLimit, setFacetPreviewLimit] = useState(10);
  const [fields, setFields] = useState<string[]>([]);
  const [facets, setFacets] = useState<Record<string, ValueHit[]>>({});
  const [facetCache, setFacetCache] = useState<Record<string, ValueHit[]>>({});
  const [expandedFacets, setExpandedFacets] = useState<Set<string>>(() => new Set());
  const [facetSearch, setFacetSearch] = useState("");
  const [selected, setSelected] = useState<LogRow | null>(null);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>(initialLogState.filters);
  const [manualField, setManualField] = useState("host");
  const [manualValue, setManualValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiSteps, setAiSteps] = useState<AiStep[]>([]);
  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState<"off" | "connecting" | "streaming" | "reconnecting" | "error">("off");
  const [mode, setMode] = useState<ViewMode>(() => modeFromPath(window.location.pathname));
  const [timeMenuOpen, setTimeMenuOpen] = useState(false);
  const [customStart, setCustomStart] = useState(() => toDatetimeLocal(initialLogState.window.start));
  const [customEnd, setCustomEnd] = useState(() => toDatetimeLocal(initialLogState.window.end));
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);
  const [dragRange, setDragRange] = useState<{ anchor: number; cursor: number } | null>(null);
  const histogramRef = useRef<HTMLElement | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const latestAssistantMessageRef = useRef<HTMLElement | null>(null);
  const tailRef = useRef<EventSource | null>(null);
  const aiCloseTimerRef = useRef<number | null>(null);
  const manualValueRef = useRef<HTMLInputElement | null>(null);
  const tailSeenRef = useRef<Set<string>>(new Set());
  const tailQueueRef = useRef<LogRow[]>([]);
  const tailRowsBufferRef = useRef<LogRow[]>([]);
  const constellationRef = useRef<HTMLDivElement | null>(null);
  const tailRecentRef = useRef<LogRow[]>([]);
  const selectedEventIdRef = useRef<string | null>(selectedEventIdFromUrl());
  const searchRunIdRef = useRef(0);
  const facetRunIdRef = useRef(0);

  function updateAppUrl(
    nextMode: ViewMode,
    eventId?: string | null,
    replace = false,
    nextQuery = query,
    nextFilters = appliedFilters,
    nextWindow = timeWindow
  ) {
    if (!["/", "/browse"].includes(window.location.pathname)) return;
    const next = buildAppUrl(nextMode, eventId, nextQuery, nextFilters, nextWindow);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current === next) return;
    window.history[replace ? "replaceState" : "pushState"]({}, "", next);
  }

  function selectLogEvent(row: LogRow, replace = false) {
    const id = storeLogEvent(row);
    selectedEventIdRef.current = id;
    setSelected(row);
    setCopiedPrompt(false);
    setCopiedJson(false);
    setLive(false);
    setMode("explore");
    updateAppUrl("explore", id, replace);
  }

  function clearSelectedLogEvent(replace = false) {
    selectedEventIdRef.current = null;
    setSelected(null);
    setCopiedPrompt(false);
    setCopiedJson(false);
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
    if (row) {
      setSelected(row);
      setCopiedPrompt(false);
      setCopiedJson(false);
    }
  }

  useEffect(() => {
    function handlePopState() {
      const nextMode = modeFromPath(window.location.pathname);
      const nextState = logStateFromUrl();
      setMode(nextMode);
      setQuery(nextState.query);
      setDraftQuery(nextState.query);
      setTimeWindow(nextState.window);
      setAppliedFilters(nextMode === "explore" ? nextState.filters : []);
      if (nextMode === "explore") {
        restoreSelectedLogEvent();
        void runSearch(nextState.query, { replaceUrl: true, filters: nextState.filters, window: nextState.window });
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
      if (appliedFilters.length > 0) setAppliedFilters([]);
      if (hasTimeWindow(timeWindow)) setTimeWindow({});
    }
    updateAppUrl(mode, mode === "explore" ? selectedEventIdRef.current : null);
  }, [mode, selected]);

  /** Run the visible query and update every dependent panel, ignoring stale responses from older runs. */
  async function runSearch(
    nextQuery = draftQuery,
    options: { relaxIfEmpty?: boolean; replaceUrl?: boolean; filters?: AppliedFilter[]; window?: QueryWindow; limit?: number } = {}
  ) {
    const runId = ++searchRunIdRef.current;
    const isCurrentRun = () => runId === searchRunIdRef.current;
    setLoading(true);
    setError("");
    try {
      const activeWindow = options.window ?? timeWindow;
      const activeFilters = options.filters ?? appliedFilters;
      const activeLimit = options.limit ?? 500;
      let activeQuery = nextQuery;
      let backendQuery = queryWithExpandedFilters(activeQuery, activeFilters);
      let searchResult = await searchLogs(backendQuery, activeLimit, activeWindow);
      let activeHitStepMs = histogramStepMs(activeQuery, activeWindow);
      let activeHitRange = timeRangeForQuery(activeQuery, activeWindow);
      const relaxations: string[] = [];
      if (options.relaxIfEmpty) {
        let attempts = 0;
        while ((searchResult.rows?.length ?? 0) === 0 && attempts < 4) {
          const relaxed = relaxQuery(activeQuery);
          if (!relaxed || relaxed === activeQuery) break;
          relaxations.push(relaxed);
          activeQuery = relaxed;
          backendQuery = queryWithExpandedFilters(activeQuery, activeFilters);
          activeHitStepMs = histogramStepMs(activeQuery, activeWindow);
          activeHitRange = timeRangeForQuery(activeQuery, activeWindow);
          searchResult = await searchLogs(backendQuery, activeLimit, activeWindow);
          attempts += 1;
        }
      }
      const [hitResult, fieldResult, errorHitResult, warningHitResult, infoHitResult, debugHitResult] = await Promise.allSettled([
        getHits(backendQuery, durationToken(activeHitStepMs), activeWindow),
        getFields(backendQuery, activeWindow),
        getHits(queryWithExpandedFilters(queryWithLevelBucket(activeQuery, "error"), activeFilters), durationToken(activeHitStepMs), activeWindow),
        getHits(queryWithExpandedFilters(queryWithLevelBucket(activeQuery, "warning"), activeFilters), durationToken(activeHitStepMs), activeWindow),
        getHits(queryWithExpandedFilters(queryWithLevelBucket(activeQuery, "info"), activeFilters), durationToken(activeHitStepMs), activeWindow),
        getHits(queryWithExpandedFilters(queryWithLevelBucket(activeQuery, "debug"), activeFilters), durationToken(activeHitStepMs), activeWindow)
      ]);
      if (!isCurrentRun()) return { query: activeQuery, relaxations };
      const hitsResponse = settledValue<HitsResponse>(hitResult, { values: [] });
      const fieldsResponse = settledValue<{ values?: ValueHit[] }>(fieldResult, { values: [] });
      const nextRows = searchResult.rows.length ? rowsNewestFirst(searchResult.rows) : [];
      setRows(nextRows);
      const selectedId = selectedEventIdFromUrl();
      if (selectedId) {
        selectedEventIdRef.current = selectedId;
        setSelected(rowForEventId(selectedId, nextRows));
      } else {
        setSelected(null);
      }
      setQuery(activeQuery);
      setTimeWindow(activeWindow);
      setHitStepMs(activeHitStepMs);
      setHitRange(activeHitRange);
      if (relaxations.length === 0) setDraftQuery(activeQuery);
      if (mode === "explore") {
        updateAppUrl("explore", selectedEventIdRef.current, options.replaceUrl ?? false, activeQuery, activeFilters, activeWindow);
      }
      setAiRelaxations(relaxations);
      setHits(normalizeHitBuckets(hitsResponse));
      setHistogramLevelHits({
        error: normalizeHitBuckets(settledValue<HitsResponse>(errorHitResult, { values: [] })),
        warning: normalizeHitBuckets(settledValue<HitsResponse>(warningHitResult, { values: [] })),
        info: normalizeHitBuckets(settledValue<HitsResponse>(infoHitResult, { values: [] })),
        debug: normalizeHitBuckets(settledValue<HitsResponse>(debugHitResult, { values: [] }))
      });
      const nextFields = (fieldsResponse.values ?? [])
        .map((item) => item.value.trim())
        .filter(Boolean)
        .slice(0, 24);
      setFields(Array.from(new Set([...fieldMappings.defaultFields, ...nextFields])));
      void refreshFacets(activeQuery, activeFilters, activeWindow);
      return { query: activeQuery, relaxations };
    } catch (err) {
      if (!isCurrentRun()) return { query: nextQuery, relaxations: [] };
      setError(err instanceof Error ? err.message : "Search failed");
      return { query: nextQuery, relaxations: [] };
    } finally {
      if (isCurrentRun()) setLoading(false);
    }
  }

  async function loadFacetValues(field: string, baseQuery = query, filters = appliedFilters, window = timeWindow): Promise<ValueHit[]> {
    const fieldsToLoad = aliasFieldsForFilter(field);
    const backendQuery = queryWithExpandedFilters(baseQuery, filters);
    const results = await Promise.all(fieldsToLoad.map((sourceField) => getFieldValues(backendQuery, sourceField, window)));
    return mergeFacetValues(field, ...results.map((result) => result.values));
  }

  async function loadFacet(field: string, baseQuery = query, filters = appliedFilters, window = timeWindow) {
    try {
      const nextValues = await loadFacetValues(field, baseQuery, filters, window);
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

  /** Refresh sidebar facets, preferring one batched backend call over many per-field requests. */
  async function refreshFacets(baseQuery = query, filters = appliedFilters, window = timeWindow) {
    const runId = ++facetRunIdRef.current;
    const isCurrentRun = () => runId === facetRunIdRef.current;
    const facetFields = fieldMappings.facets.map(({ field }) => field);
    if (facetFields.length === 0) return;
    const fieldsToLoad = Array.from(new Set(facetFields.flatMap((field) => aliasFieldsForFilter(field))));

    try {
      const backendQuery = queryWithExpandedFilters(baseQuery, filters);
      const batch = normalizeFacetResponse(await getFacets(backendQuery, fieldsToLoad, 100, window));
      if (!isCurrentRun()) return;
      if (Object.keys(batch).length > 0) {
        const nextValues = Object.fromEntries(
          facetFields.map((field) => [field, mergeFacetValues(field, ...aliasFieldsForFilter(field).map((alias) => batch[alias]))])
        );
        const hasValues = Object.values(nextValues).some((values) => values.length > 0);
        if (!hasValues) throw new Error("Batched facet response did not include configured alias values.");
        setFacets((current) => ({ ...current, ...nextValues }));
        setFacetCache((current) => {
          const merged = { ...current };
          facetFields.forEach((field) => {
            merged[field] = mergeFacetValues(field, current[field], nextValues[field]);
          });
          return merged;
        });
        return;
      }
    } catch {
      // Fall back to per-field loading below. Older or mocked VictoriaLogs responses may not support batch facets.
    }

    const entries = await Promise.all(facetFields.map(async (field) => [field, await loadFacetValues(field, baseQuery, filters, window)] as const));
    if (!isCurrentRun()) return;
    const nextValues = Object.fromEntries(entries);
    setFacets((current) => ({ ...current, ...nextValues }));
    setFacetCache((current) => {
      const merged = { ...current };
      entries.forEach(([field, values]) => {
        merged[field] = mergeFacetValues(field, current[field], values);
      });
      return merged;
    });
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

  function applyFilter(field: string, value: string, exclude = false) {
    const cleanValue = value.trim();
    if (!field || !cleanValue) return;
    const displayValue = displayFacetValue(field, cleanValue);
    if (appliedFilters.some((item) => item.field === field && item.value === displayValue && Boolean(item.exclude) === exclude)) return;
    const nextFilters = [
      ...appliedFilters.filter((item) => !(item.field === field && item.value === displayValue && Boolean(item.exclude) !== exclude)),
      { field, value: displayValue, token: "", exclude }
    ];
    const next = buildQueryWithFilters(draftQuery, appliedFilters, nextFilters);
    setDraftQuery(next.query);
    setAppliedFilters(next.filters);
    void runSearch(next.query, { filters: next.filters });
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
    const existing = appliedFilters.find((item) => item.field === field && item.value === displayValue && !item.exclude);
    if (existing) {
      removeFilter(existing);
      return;
    }
    applyFilter(field, displayValue);
  }

  function removeFilter(filter: AppliedFilter) {
    const nextFilters = appliedFilters.filter((item) => !(item.field === filter.field && item.value === filter.value && Boolean(item.exclude) === Boolean(filter.exclude)));
    const next = buildQueryWithFilters(draftQuery, appliedFilters, nextFilters);
    setDraftQuery(next.query);
    setAppliedFilters(next.filters);
    void runSearch(next.query, { filters: next.filters });
  }

  function runDraftQuery() {
    const representedFilters = appliedFilters.filter((filter) => filter.token && draftQuery.includes(filter.token));
    if (representedFilters.length !== appliedFilters.length) setAppliedFilters(representedFilters);
    void runSearch(draftQuery, { filters: representedFilters });
  }

  function scrollConversationToBottom() {
    window.requestAnimationFrame(() => {
      const element = conversationScrollRef.current;
      if (!element) return;
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    });
  }

  function scrollConversationToLatestAssistant() {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const container = conversationScrollRef.current;
        const target = latestAssistantMessageRef.current;
        if (!container || !target) return;
        const containerTop = container.getBoundingClientRect().top;
        const targetTop = target.getBoundingClientRect().top;
        container.scrollTo({
          top: container.scrollTop + targetTop - containerTop,
          behavior: "smooth"
        });
      });
    });
  }

  async function askAi(promptOverride?: string, options: { followUp?: boolean } = {}) {
    if (!aiEnabled) return;
    const promptToUse = (promptOverride ?? aiPrompt).trim();
    if (!promptToUse) return;
    if (promptOverride && !options.followUp) setAiPrompt(promptOverride);
    const startedFromExplore = mode === "explore";
    const baseConversation = options.followUp ? aiConversation : [];
    const conversation = options.followUp
      ? [...baseConversation, { role: "user", content: promptToUse } satisfies AiConversationMessage].slice(-12)
      : [];
    const incidentContext: AiIncidentContext = options.followUp
      ? {
          query,
          explanation: aiExplanation,
          evidence: aiEvidence,
          relaxations: aiRelaxations,
          totalLogs,
          rows: (rows.length > 0 ? rows : tailRecentRef.current.slice(-12).reverse()).slice(0, 12).map(compactIncidentRow)
        }
      : {};
    setLoading(true);
    setError("");
    if (aiCloseTimerRef.current !== null) window.clearTimeout(aiCloseTimerRef.current);
    if (options.followUp) {
      setFollowUpPrompt("");
      setAiConversation(conversation);
      setFollowUpThinking(true);
      scrollConversationToBottom();
    } else {
      setAiModalOpen(true);
      setAiRunning(true);
    }
    const timer = options.followUp ? 0 : beginAiProgress();
    try {
      const result = await generateQuery(promptToUse, draftQuery, fields, conversation, incidentContext);
      if (!options.followUp) {
        window.clearInterval(timer);
        setAiSteps((current) => current.map((step) => ({ ...step, status: "done" as const })));
      }
      const queryChanged = result.query_changed !== false;
      if (!options.followUp || queryChanged) {
        setDraftQuery(result.query);
        setAiExplanation(result.explanation || "");
        setAiEvidence(result.evidence ?? []);
      }
      const assistantSummary = [
        result.explanation,
        (result.evidence?.length ?? 0) > 0 ? `Evidence: ${(result.evidence ?? []).slice(0, 3).join(" ")}` : "",
        queryChanged ? `Generated query: ${result.query}` : `Query unchanged: ${result.query}`
      ].filter(Boolean).join("\n\n");
      const nextConversation: AiConversationMessage[] = [
        ...conversation,
        { role: "assistant", content: assistantSummary }
      ];
      setAiConversation(nextConversation.slice(-12));
      scrollConversationToLatestAssistant();
      if (!options.followUp) {
        aiCloseTimerRef.current = window.setTimeout(() => {
          setAiModalOpen(false);
          aiCloseTimerRef.current = null;
        }, 220);
      }
      if (!startedFromExplore) setMode("answer");
      if (!options.followUp || queryChanged) {
        setAppliedFilters([]);
        void runSearch(result.query, { filters: [], limit: 2000 });
      }
    } catch (err) {
      if (!options.followUp) window.clearInterval(timer);
      const message = err instanceof Error ? err.message : "AI query generation failed";
      setError(message);
      if (options.followUp) {
        const failedConversation: AiConversationMessage[] = [
          ...conversation,
          { role: "assistant", content: `I couldn't complete that follow-up: ${message}` }
        ];
        setAiConversation(failedConversation.slice(-12));
        scrollConversationToLatestAssistant();
      } else {
        setAiSteps((current) => [
          ...current.map((step) => (step.status === "running" ? { ...step, status: "error" as const } : step)),
          { title: "AI request failed", status: "error", detail: message }
        ]);
      }
    } finally {
      setAiRunning(false);
      setFollowUpThinking(false);
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
    let cancelled = false;
    getAppConfig()
      .then((config) => {
        if (cancelled) return;
        setActiveFieldMappings(config.fieldMappings);
        setFieldMappings(config.fieldMappings);
        setFields(config.fieldMappings.defaultFields);
        setFacetPreviewLimit(Math.max(1, Math.min(250, Math.floor(config.facetPreviewLimit ?? 10))));
        setAiEnabled(config.aiEnabled);
        if (!config.aiEnabled && mode !== "explore") setMode("explore");
        setConfigReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveFieldMappings(emptyFieldMappings);
        setFieldMappings(emptyFieldMappings);
        setAiEnabled(false);
        if (mode !== "explore") setMode("explore");
        setConfigReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!configReady) return;
    void runSearch(initialLogState.query, { replaceUrl: true, filters: initialLogState.filters, window: initialLogState.window });
  }, [configReady]);

  useEffect(() => {
    setActiveFieldMappings(fieldMappings);
  }, [fieldMappings]);

  useEffect(() => {
    setFields((current) => Array.from(new Set([...fieldMappings.defaultFields, ...current])));
  }, [fieldMappings]);

  useEffect(() => {
    if (configReady && fields.length > 0 && !fields.includes(manualField)) {
      setManualField(fields[0]);
    }
  }, [configReady, fields, manualField]);

  useEffect(() => {
    if (mode === "explore") restoreSelectedLogEvent();
  }, []);

  useEffect(() => {
    return () => {
      if (aiCloseTimerRef.current !== null) window.clearTimeout(aiCloseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") clearSelectedLogEvent();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    tailRef.current?.close();
    tailRowsBufferRef.current = [];
    const shouldStream = !hasTimeWindow(timeWindow) && (live || (aiEnabled === true && mode === "welcome"));
    if (!shouldStream) {
      setLiveStatus("off");
      return;
    }
    setLiveStatus("connecting");
    const source = new EventSource(tailUrl(queryWithExpandedFilters(query, appliedFilters)));
    tailRef.current = source;
    const flushTailRows = () => {
      const pending = tailRowsBufferRef.current;
      if (pending.length === 0) return;
      tailRowsBufferRef.current = [];
      setRows((current) => [...pending.reverse(), ...current].slice(0, 500));
    };
    const flushInterval = window.setInterval(flushTailRows, 120);
    source.onopen = () => setLiveStatus("streaming");
    source.onmessage = (event) => {
      try {
        tailRowsBufferRef.current.push(JSON.parse(event.data) as LogRow);
      } catch {
        tailRowsBufferRef.current.push({ _time: new Date().toISOString(), _msg: event.data });
      }
    };
    source.onerror = () => setLiveStatus(source.readyState === EventSource.CLOSED ? "error" : "reconnecting");
    return () => {
      window.clearInterval(flushInterval);
      flushTailRows();
      source.close();
      setLiveStatus("off");
    };
  }, [live, query, appliedFilters, mode, timeWindow]);

  const histogram = useMemo(() => {
    const step = Math.max(1000, hitStepMs);
    const bucketCount = 180;
    const minTime = hitRange.end - bucketCount * step;
    const totals = Array.from({ length: bucketCount }, () => 0);
    const errors = Array.from({ length: bucketCount }, () => 0);
    const warnings = Array.from({ length: bucketCount }, () => 0);
    const infos = Array.from({ length: bucketCount }, () => 0);
    const debugs = Array.from({ length: bucketCount }, () => 0);

    function addHit(hit: HitBucket, target: number[]) {
      const t = hitTimestamp(hit);
      if (Number.isNaN(t)) return;
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - minTime) / step)));
      target[idx] += countFromHit(hit);
    }

    hits.forEach((hit) => addHit(hit, totals));
    histogramLevelHits.error.forEach((hit) => addHit(hit, errors));
    histogramLevelHits.warning.forEach((hit) => addHit(hit, warnings));
    histogramLevelHits.info.forEach((hit) => addHit(hit, infos));
    histogramLevelHits.debug.forEach((hit) => addHit(hit, debugs));

    const hasSeverityHits = [...errors, ...warnings, ...infos, ...debugs].some((count) => count > 0);
    if (!hasSeverityHits) {
      rows.forEach((row) => {
        const t = rowTimestamp(row);
        if (Number.isNaN(t)) return;
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((t - minTime) / step)));
        const severity = severityKey(levelValue(row));
        if (severity === "error") errors[idx] += 1;
        if (severity === "warning") warnings[idx] += 1;
        if (severity === "info") infos[idx] += 1;
        if (severity === "debug") debugs[idx] += 1;
      });
    }

    const maxTotal = Math.max(1, ...totals);
    const buckets = totals.map((total, i) => {
      const height = total === 0 ? 0 : Math.max(3, Math.round((total / maxTotal) * 72));
      const startTime = minTime + i * step;
      const endTime = startTime + step;
      const errorCount = Math.min(total, errors[i]);
      const warningCount = Math.min(Math.max(0, total - errorCount), warnings[i]);
      const infoCount = Math.min(Math.max(0, total - errorCount - warningCount), infos[i]);
      const debugCount = Math.min(Math.max(0, total - errorCount - warningCount - infoCount), debugs[i]);
      const otherCount = Math.max(0, total - errorCount - warningCount - infoCount - debugCount);
      const pct = (value: number) => total > 0 ? (value / total) * 100 : 0;
      return {
        key: i,
        total,
        height,
        startTime,
        endTime,
        error: pct(errorCount),
        warning: pct(warningCount),
        info: pct(infoCount),
        debug: pct(debugCount),
        other: pct(otherCount),
        label: `${total} logs from ${formatBucketTime(startTime, step)} to ${formatBucketTime(endTime, step)}`
      };
    });
    return { buckets, maxTotal };
  }, [hits, histogramLevelHits, hitRange, hitStepMs, rows]);

  const selectedHistogramRange = dragRange && histogram.buckets.length
    ? {
        start: Math.min(dragRange.anchor, dragRange.cursor),
        end: Math.max(dragRange.anchor, dragRange.cursor)
      }
    : null;
  const histogramTicks = useMemo(() => {
    if (histogram.buckets.length === 0) return [];
    const tickCount = 6;
    return Array.from({ length: tickCount }, (_value, index) => {
      const bucketIndex = Math.round((index / (tickCount - 1)) * (histogram.buckets.length - 1));
      const bucket = histogram.buckets[bucketIndex];
      return {
        key: `${bucket.key}-${bucket.startTime}`,
        label: formatBucketTime(bucket.startTime, hitStepMs),
        left: `${(bucketIndex / Math.max(1, histogram.buckets.length - 1)) * 100}%`
      };
    });
  }, [histogram.buckets, hitStepMs]);

  function bucketIndexFromClientX(clientX: number): number | null {
    const element = histogramRef.current;
    if (!element || histogram.buckets.length === 0) return null;
    const rect = element.getBoundingClientRect();
    const ratio = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.min(histogram.buckets.length - 1, Math.max(0, Math.floor(ratio * histogram.buckets.length)));
  }

  function updateHoveredBucket(clientX: number) {
    const index = bucketIndexFromClientX(clientX);
    if (index !== null) setHoveredBucket(index);
    return index;
  }

  function applyHistogramRange(startIndex: number, endIndex: number) {
    const start = histogram.buckets[Math.min(startIndex, endIndex)];
    const end = histogram.buckets[Math.max(startIndex, endIndex)];
    if (!start || !end) return;
    const nextWindow = {
      start: new Date(start.startTime).toISOString(),
      end: new Date(end.endTime).toISOString()
    };
    const nextQuery = replaceTimeToken(draftQuery, timeRangeToken(nextWindow));
    setDraftQuery(nextQuery);
    setTimeWindow({});
    setLive(false);
    void runSearch(nextQuery, { window: {}, filters: appliedFilters });
  }

  function clearTimeWindow() {
    setTimeWindow({});
    void runSearch(draftQuery, { window: {}, filters: appliedFilters });
  }

  function resetLogQuery() {
    setDraftQuery(defaultLogQuery);
    setAppliedFilters([]);
    setTimeWindow({});
    setLive(false);
    void runSearch(defaultLogQuery, { filters: [], window: {} });
  }

  function openTimeMenu() {
    if (!timeMenuOpen) {
      if (hasTimeWindow(timeWindow)) {
        setCustomStart(toDatetimeLocal(timeWindow.start));
        setCustomEnd(toDatetimeLocal(timeWindow.end));
      } else {
        const tokenRange = parseTimeRangeToken(timeToken(draftQuery));
        if (tokenRange) {
          setCustomStart(toDatetimeLocal(new Date(tokenRange.start).toISOString()));
          setCustomEnd(toDatetimeLocal(new Date(tokenRange.end).toISOString()));
        } else if (!customStart || !customEnd) {
          const fallback = defaultCustomWindow();
          setCustomStart(fallback.start);
          setCustomEnd(fallback.end);
        }
      }
    }
    setTimeMenuOpen((current) => !current);
  }

  function applyTimePreset(nextQueryToken: string) {
    const nextQuery = replaceTimeToken(draftQuery, nextQueryToken);
    setDraftQuery(nextQuery);
    setTimeWindow({});
    setTimeMenuOpen(false);
    void runSearch(nextQuery, { window: {}, filters: appliedFilters });
  }

  function applyCustomTimeWindow() {
    const start = datetimeLocalToIso(customStart);
    const end = datetimeLocalToIso(customEnd);
    if (!start || !end || Date.parse(start) >= Date.parse(end)) {
      setError("Choose a valid custom time range.");
      return;
    }
    const nextWindow = { start, end };
    const nextQuery = replaceTimeToken(draftQuery, timeRangeToken(nextWindow));
    setDraftQuery(nextQuery);
    setTimeWindow({});
    setLive(false);
    setTimeMenuOpen(false);
    void runSearch(nextQuery, { window: {}, filters: appliedFilters });
  }

  async function copySelectedPrompt() {
    if (!selected) return;
    await copyText(promptForLogEvent(selected));
    setCopiedPrompt(true);
    window.setTimeout(() => setCopiedPrompt(false), 1800);
  }

  async function copySelectedJson() {
    if (!selected) return;
    await copyText(prettyLogJson(selected));
    setCopiedJson(true);
    window.setTimeout(() => setCopiedJson(false), 1800);
  }

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

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => logScrollRef.current,
    estimateSize: () => 32,
    overscan: 16
  });

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
    if (mode !== "welcome") return;
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
  }, [mode]);

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

  const severityStats = useMemo<SeverityStats>(() => {
    const counts = emptySeverityCounts();
    const rowCounts = severityCountsFromRows(rows);
    const levelFacet = facets.level;
    if (levelFacet && levelFacet.length > 0) {
      levelFacet.forEach((item) => {
        counts[severityKey(item.value)] += item.hits;
      });
      (Object.keys(counts) as Array<keyof SeverityCounts>).forEach((key) => {
        counts[key] = Math.max(counts[key], rowCounts[key]);
      });
      return { counts, classifiedTotal: levelFacet.reduce((sum, item) => sum + item.hits, 0), source: "facet" };
    }
    return { counts: rowCounts, classifiedTotal: rows.length, source: "rows" };
  }, [rows, facets]);
  const severityCounts = severityStats.counts;
  const unclassifiedSeverityCount = Math.max(0, totalLogs - severityStats.classifiedTotal);
  const showUnclassifiedSeverity = severityStats.source === "facet" && unclassifiedSeverityCount > 0;

  function runSuggestion(prompt: string) {
    void askAi(prompt);
  }

  const findings = useMemo(() => buildFindings(rows, totalLogs), [rows, totalLogs]);

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
    const known = new Set([
      ...fieldMappings.facets.map((filter) => filter.field),
      ...Object.values(fieldMappings.aliases).flat()
    ]);
    return [
      ...fieldMappings.facets,
      ...fields
        .filter((field) => !known.has(field))
        .map((field) => ({ field, label: field }))
    ];
  }, [fields, fieldMappings]);

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

  function expandFacet(field: string) {
    setExpandedFacets((current) => {
      const next = new Set(current);
      next.add(field);
      return next;
    });
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

  const activePreset = presetForQuery(draftQuery);
  const timeButtonLabel = hasTimeWindow(timeWindow) ? formatTimeWindow(timeWindow) : activePreset.label;
  const timeButtonBadge = hasTimeWindow(timeWindow) ? "range" : activePreset.shortLabel;
  const liveTailMode = mode === "explore" && live && !hasTimeWindow(timeWindow);

  return (
    <>
    <div className={`shell ${mode !== "explore" && aiEnabled === true ? "shell-dimmed" : ""} ${liveTailMode ? "shell-live-tail" : ""}`} aria-hidden={mode !== "explore" && aiEnabled === true}>
      <header className="app-chrome">
        <div className="product">
          <div className="mark" aria-label="Hikari"><HikariSparkle size={20} /></div>
          <div>
            <strong>Hikari</strong>
            <span>Log analysis system</span>
          </div>
        </div>
        <div className="time-controls">
          {mode === "explore" && aiEnabled === true && (
            <button className="ask-ai-button" onClick={() => setMode("welcome")} title="Ask AI">
              <Sparkles size={14} />
              <span>Ask AI</span>
            </button>
          )}
          <div className="time-menu-wrap">
            <button className="time-button" title="Time range" aria-expanded={timeMenuOpen} onClick={openTimeMenu}>
              <Clock size={15} />
              <strong>{timeButtonBadge}</strong>
              <span>{timeButtonLabel}</span>
            </button>
            {timeMenuOpen && (
              <div className="time-menu" role="menu" aria-label="Time range">
                <div className="time-menu-section">
                  {timePresets.map((preset) => (
                    <button
                      key={preset.query}
                      className={timeToken(draftQuery) === preset.query && !hasTimeWindow(timeWindow) ? "active" : ""}
                      onClick={() => applyTimePreset(preset.query)}
                    >
                      <span>{preset.label}</span>
                      <code>{preset.shortLabel}</code>
                    </button>
                  ))}
                </div>
                <div className="time-custom">
                  <label>
                    <span>Start</span>
                    <input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
                  </label>
                  <label>
                    <span>End</span>
                    <input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
                  </label>
                  <button onClick={applyCustomTimeWindow}>Apply custom range</button>
                </div>
              </div>
            )}
          </div>
          <button className="icon-button" onClick={() => setLive((current) => !current)} title={live ? "Pause live tail" : "Start live tail"}>
            {live ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button className="icon-button" onClick={runDraftQuery} title="Run query">
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
              if (event.key === "Enter") runDraftQuery();
            }}
            aria-label="LogsQL query"
            placeholder="Filter your logs. Press Space to search using natural language queries."
          />
          {(draftQuery.trim() !== defaultLogQuery || appliedFilters.length > 0 || hasTimeWindow(timeWindow)) && (
            <button className="clear-query-button" onClick={resetLogQuery} title="Clear query and filters" aria-label="Clear query and filters">
              <X size={16} />
            </button>
          )}
          <button className="add-button" onClick={runDraftQuery}>Add</button>
        </div>
        {(appliedFilters.length > 0 || hasTimeWindow(timeWindow)) && (
          <div className="active-filters query-active-filters" aria-label="Active filters">
            {hasTimeWindow(timeWindow) && (
              <button onClick={clearTimeWindow}>
                <X size={12} />
                <span>time:{formatTimeWindow(timeWindow)}</span>
              </button>
            )}
            {appliedFilters.map((filter) => (
              <button key={`${filter.exclude ? "not:" : ""}${filter.field}:${filter.value}`} className={filter.exclude ? "exclude" : ""} onClick={() => removeFilter(filter)}>
                <X size={12} />
                <span>{filter.exclude ? "not " : ""}{filter.field}:{filter.value}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {!liveTailMode && (
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
                const expanded = expandedFacets.has(field) || Boolean(facetSearch.trim());
                const visibleValues = expanded ? values.slice(0, 250) : values.slice(0, facetPreviewLimit);
                const hiddenCount = Math.max(0, Math.min(values.length, 250) - visibleValues.length);
                return (
                  <details key={field} open={Boolean(facetSearch.trim()) || ["environment", "service", "host", "level"].includes(field)}>
                    <summary>
                      <span>{label}</span>
                      <CheckCircle2 size={13} />
                    </summary>
                    {visibleValues.map((item) => (
                      <button key={`${field}-${item.value}`} onClick={() => toggleFilter(field, item.value)}>
                        <input type="checkbox" checked={appliedFilters.some((filter) => filter.field === field && filter.value === item.value)} readOnly />
                        <i className={`facet-swatch ${field === "level" ? item.value.toLowerCase() : ""}`} />
                        <span>{item.value}</span>
                        <em>{item.hits}</em>
                      </button>
                    ))}
                    {!expanded && hiddenCount > 0 && (
                      <button className="facet-view-more" onClick={() => expandFacet(field)}>
                        <span>View more</span>
                        <em>+{hiddenCount}</em>
                      </button>
                    )}
                  </details>
                );
              })}
            </div>
          </section>
        </aside>
      )}

      <main className="workspace">
        {aiEnabled === true && (
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
        )}

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

        <section
          className={`histogram ${dragRange ? "selecting" : ""}`}
          aria-label="Log volume histogram"
          ref={histogramRef}
          onPointerDown={(event) => {
            const index = updateHoveredBucket(event.clientX);
            if (index === null) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragRange({ anchor: index, cursor: index });
          }}
          onPointerMove={(event) => {
            const index = updateHoveredBucket(event.clientX);
            if (index !== null && dragRange) setDragRange((current) => current ? { ...current, cursor: index } : current);
          }}
          onPointerUp={(event) => {
            const index = updateHoveredBucket(event.clientX);
            if (dragRange && index !== null) applyHistogramRange(dragRange.anchor, index);
            setDragRange(null);
          }}
          onPointerLeave={() => {
            if (!dragRange) setHoveredBucket(null);
          }}
        >
          <div className="histogram-y-label" aria-hidden="true">Logs</div>
          <div className="histogram-y-max" aria-hidden="true">{histogram.maxTotal}</div>
          <div className="histogram-y-min" aria-hidden="true">0</div>
          <div className="histogram-x-label" aria-hidden="true">Time</div>
          <div className="histogram-ticks" aria-hidden="true">
            {histogramTicks.map((tick) => (
              <span key={tick.key} style={{ left: tick.left }}>{tick.label}</span>
            ))}
          </div>
          {selectedHistogramRange && (
            <span
              className="histogram-selection"
              style={{
                left: `${(selectedHistogramRange.start / histogram.buckets.length) * 100}%`,
                width: `${((selectedHistogramRange.end - selectedHistogramRange.start + 1) / histogram.buckets.length) * 100}%`
              }}
            />
          )}
          {histogram.buckets.map((bar) => (
            <span key={bar.key} className={`hbar ${hoveredBucket === bar.key ? "hovered" : ""}`} style={{ height: `${bar.height}px` }} title={bar.label}>
              {bar.error > 0 && <i className="seg error" style={{ flexBasis: `${bar.error}%` }} />}
              {bar.warning > 0 && <i className="seg warning" style={{ flexBasis: `${bar.warning}%` }} />}
              {bar.info > 0 && <i className="seg info" style={{ flexBasis: `${bar.info}%` }} />}
              {bar.debug > 0 && <i className="seg debug" style={{ flexBasis: `${bar.debug}%` }} />}
              {bar.other > 0 && <i className="seg other" style={{ flexBasis: `${bar.other}%` }} />}
            </span>
          ))}
          {hoveredBucket !== null && histogram.buckets[hoveredBucket] && (
            <div className="histogram-tooltip" style={{ left: `${((hoveredBucket + 0.5) / histogram.buckets.length) * 100}%` }}>
              <strong>{histogram.buckets[hoveredBucket].total} logs</strong>
              <span>{formatBucketTime(histogram.buckets[hoveredBucket].startTime, hitStepMs)} - {formatBucketTime(histogram.buckets[hoveredBucket].endTime, hitStepMs)}</span>
            </div>
          )}
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
          <div className="log-scroll" ref={logScrollRef}>
            {rows.length === 0 && (
              <div className="log-empty">
                {loading ? "Loading logs..." : "No logs match the current query."}
              </div>
            )}
            {rows.length > 0 && (
              <div className="log-virtual-space" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  return (
                    <div
                      key={virtualRow.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      role="button"
                      tabIndex={0}
                      onClick={() => selectLogEvent(row)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") selectLogEvent(row);
                      }}
                      className={`log-row sev-${severityKey(levelValue(row))} ${selected === row ? "selected" : ""}`}
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {logColumns.columns.map((column) => <React.Fragment key={column.key}>{renderLogCell(column.key, row)}</React.Fragment>)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
              <div className="drawer-actions">
                <button onClick={() => void copySelectedJson()} title="Copy log JSON">
                  {copiedJson ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                  <span>{copiedJson ? "Copied" : "JSON"}</span>
                </button>
                <button onClick={() => void copySelectedPrompt()} title="Copy investigation prompt">
                  {copiedPrompt ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                  <span>{copiedPrompt ? "Copied" : "Prompt"}</span>
                </button>
                <button onClick={() => clearSelectedLogEvent()} title="Close" aria-label="Close"><X size={17} /></button>
              </div>
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
                    <button title="Exclude this value" onClick={() => applyFilter(key, asText(value), true)}>
                      <Minus size={13} />
                    </button>
                  </div>
                ))}
            </div>
          </aside>
        </div>
      )}

    </div>

    {mode === "welcome" && aiEnabled === true && (
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
            {showUnclassifiedSeverity && (
              <span className="dot unclassified" title="Logs without a recognized level field">
                {unclassifiedSeverityCount.toLocaleString()} unclassified
              </span>
            )}
          </div>
        </div>
      </div>
    )}

    {mode === "answer" && aiEnabled === true && !aiModalOpen && (
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

            <div className="answer-conversation">
              <div className="answer-conversation-head">
                <span className="answer-section-label">Conversation</span>
                <span>Follow-ups use this thread and the related log rows below.</span>
              </div>
              {(aiConversation.length > 0 || followUpThinking) && (
                <div className="answer-message-list" ref={conversationScrollRef}>
                  {aiConversation.map((messageItem, index) => (
                    <article
                      key={`ai-message-${index}`}
                      className={`answer-message ${messageItem.role}`}
                      ref={messageItem.role === "assistant" && index === aiConversation.length - 1 ? latestAssistantMessageRef : undefined}
                    >
                      <span>{messageItem.role === "user" ? "You" : "Hikari"}</span>
                      <p>{messageItem.content}</p>
                    </article>
                  ))}
                  {followUpThinking && (
                    <article className="answer-message assistant thinking">
                      <span>Hikari</span>
                      <p>
                        <i aria-hidden="true" />
                        <i aria-hidden="true" />
                        <i aria-hidden="true" />
                        Thinking through the follow-up and checking the related log rows.
                      </p>
                    </article>
                  )}
                </div>
              )}
              <form
                className="answer-followup"
                onSubmit={(event) => {
                  event.preventDefault();
                  void askAi(followUpPrompt, { followUp: true });
                }}
              >
                <input
                  value={followUpPrompt}
                  onChange={(event) => setFollowUpPrompt(event.target.value)}
                  placeholder="Ask a follow-up about these results"
                  aria-label="Ask a follow-up"
                />
                <button type="submit" disabled={!followUpPrompt.trim() || loading || aiRunning}>
                  <Sparkles size={14} />
                  Ask
                </button>
              </form>
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
                {showUnclassifiedSeverity && (
                  <span className="dot unclassified" title="Logs without a recognized level field">
                    {unclassifiedSeverityCount.toLocaleString()} unclassified
                  </span>
                )}
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
