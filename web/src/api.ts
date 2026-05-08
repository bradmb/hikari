export type LogRow = Record<string, unknown>;

/** Response shape returned by Hikari's bounded log search endpoint. */
export type SearchResponse = {
  rows: LogRow[];
  stats: { count?: number };
};

/** A VictoriaLogs field value with the number of matching rows. */
export type ValueHit = {
  value: string;
  hits: number;
};

export type HitBucket = Record<string, unknown>;

/** Flexible hit response because VictoriaLogs can return buckets in several shapes. */
export type HitsResponse = {
  values?: HitBucket[];
  hits?: Array<{
    fields?: Record<string, unknown>;
    timestamps?: Array<string | number>;
    values?: Array<number | string>;
    total?: number;
  }>;
};

/** Progress step shown while the AI investigation request is running. */
export type AiStep = {
  title: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
  tool?: string;
  items?: string[];
};

/** Absolute VictoriaLogs window passed separately from the visible LogsQL query. */
export type QueryWindow = {
  start?: string | null;
  end?: string | null;
};

/** One sidebar facet definition from the configurable field mapping file. */
export type FieldMappingFacet = {
  field: string;
  key?: string;
  label: string;
  summary?: boolean;
};

export type DerivedFieldRule = {
  type: "json" | "regex" | string;
  source?: string;
  sources?: string[];
  path?: string;
  pattern?: string;
  queryPattern?: string;
  flags?: string;
  value?: string;
};

/** Canonical fields, source aliases, and sidebar facets used by the UI. */
export type FieldMappings = {
  defaultFields: string[];
  aliases: Record<string, string[]>;
  facets: FieldMappingFacet[];
  derivedFields?: Record<string, DerivedFieldRule[]>;
};

/** Conversation context sent with AI follow-up requests. */
export type AiConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Compact incident state sent so follow-ups can answer without rediscovering context. */
export type AiIncidentContext = {
  query?: string;
  explanation?: string;
  evidence?: string[];
  relaxations?: string[];
  totalLogs?: number;
  rows?: LogRow[];
};

export type FacetsResponse = {
  values?: Record<string, ValueHit[]>;
  facets?: Array<{ field: string; values?: ValueHit[] }>;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

/** Fetch JSON from the Hikari API and surface non-2xx responses as Error objects. */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {})
    }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function windowPayload(window?: QueryWindow) {
  return {
    ...(window?.start ? { start: window.start } : {}),
    ...(window?.end ? { end: window.end } : {})
  };
}

function windowParams(params: URLSearchParams, window?: QueryWindow) {
  if (window?.start) params.set("start", window.start);
  if (window?.end) params.set("end", window.end);
  return params;
}

/** Execute a bounded LogsQL query through Hikari's field-mapping proxy. */
export function searchLogs(query: string, limit = 500, window?: QueryWindow) {
  return request<SearchResponse>("/api/search", {
    method: "POST",
    body: JSON.stringify({ query, limit, ...windowPayload(window) })
  });
}

/** Return time-bucketed hit counts for a LogsQL query. */
export function getHits(query: string, step = "1m", window?: QueryWindow) {
  return request<HitsResponse>("/api/hits", {
    method: "POST",
    body: JSON.stringify({ query, step, ...windowPayload(window) })
  });
}

/** List field names visible in the current query window. */
export function getFields(query: string, window?: QueryWindow) {
  const params = windowParams(new URLSearchParams({ query }), window);
  return request<{ values?: ValueHit[] }>(`/api/fields?${params.toString()}`);
}

/** List common values for one field, after server-side facet alias mapping is applied. */
export function getFieldValues(query: string, field: string, window?: QueryWindow) {
  const params = windowParams(new URLSearchParams({ query, field, limit: "250" }), window);
  return request<{ values?: ValueHit[] }>(`/api/field-values?${params.toString()}`);
}

/** Fetch multiple field facets in one VictoriaLogs call when the backend supports it. */
export function getFacets(query: string, fields: string[], limit = 100, window?: QueryWindow) {
  return request<FacetsResponse>("/api/facets", {
    method: "POST",
    body: JSON.stringify({ query, fields, limit, ...windowPayload(window) })
  });
}

/** Generate or refine LogsQL from a natural-language investigation request. */
export function generateQuery(
  prompt: string,
  currentQuery: string,
  fields: string[],
  conversation: AiConversationMessage[] = [],
  incidentContext: AiIncidentContext = {}
) {
  return request<{ query: string; query_changed?: boolean; explanation: string; evidence?: string[]; steps?: AiStep[] }>("/api/ai/query", {
    method: "POST",
    body: JSON.stringify({ prompt, current_query: currentQuery, fields, conversation, incident_context: incidentContext })
  });
}

/** Build the EventSource URL for live tail streaming. */
export function tailUrl(query: string) {
  const params = new URLSearchParams({ query });
  return `${API_BASE}/api/tail?${params.toString()}`;
}

/** Load runtime feature flags and field mapping configuration. */
export function getAppConfig() {
  return request<{ default_query: string; fieldMappings: FieldMappings; facetPreviewLimit?: number; aiEnabled: boolean }>("/api/config");
}
