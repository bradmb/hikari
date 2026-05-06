export type LogRow = Record<string, unknown>;

export type SearchResponse = {
  rows: LogRow[];
  stats: { count?: number };
};

export type ValueHit = {
  value: string;
  hits: number;
};

export type HitBucket = Record<string, unknown>;

export type HitsResponse = {
  values?: HitBucket[];
  hits?: Array<{
    fields?: Record<string, unknown>;
    timestamps?: Array<string | number>;
    values?: Array<number | string>;
    total?: number;
  }>;
};

export type AiStep = {
  title: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
  tool?: string;
  items?: string[];
};

export type QueryWindow = {
  start?: string | null;
  end?: string | null;
};

export type FieldMappingFacet = {
  field: string;
  key?: string;
  label: string;
  summary?: boolean;
};

export type FieldMappings = {
  defaultFields: string[];
  aliases: Record<string, string[]>;
  facets: FieldMappingFacet[];
};

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

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

export function searchLogs(query: string, limit = 500, window?: QueryWindow) {
  return request<SearchResponse>("/api/search", {
    method: "POST",
    body: JSON.stringify({ query, limit, ...windowPayload(window) })
  });
}

export function getHits(query: string, step = "1m", window?: QueryWindow) {
  return request<HitsResponse>("/api/hits", {
    method: "POST",
    body: JSON.stringify({ query, step, ...windowPayload(window) })
  });
}

export function getFields(query: string, window?: QueryWindow) {
  const params = windowParams(new URLSearchParams({ query }), window);
  return request<{ values?: ValueHit[] }>(`/api/fields?${params.toString()}`);
}

export function getFieldValues(query: string, field: string, window?: QueryWindow) {
  const params = windowParams(new URLSearchParams({ query, field, limit: "25" }), window);
  return request<{ values?: ValueHit[] }>(`/api/field-values?${params.toString()}`);
}

export function generateQuery(prompt: string, currentQuery: string, fields: string[]) {
  return request<{ query: string; explanation: string; evidence?: string[]; steps?: AiStep[] }>("/api/ai/query", {
    method: "POST",
    body: JSON.stringify({ prompt, current_query: currentQuery, fields })
  });
}

export function tailUrl(query: string) {
  const params = new URLSearchParams({ query });
  return `${API_BASE}/api/tail?${params.toString()}`;
}

export function getAppConfig() {
  return request<{ default_query: string; fieldMappings: FieldMappings }>("/api/config");
}
