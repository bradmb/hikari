export type LogRow = Record<string, unknown>;

export type SearchResponse = {
  rows: LogRow[];
  stats: { count?: number };
};

export type ValueHit = {
  value: string;
  hits: number;
};

export type AiStep = {
  title: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
  tool?: string;
  items?: string[];
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

export function searchLogs(query: string, limit = 500) {
  return request<SearchResponse>("/api/search", {
    method: "POST",
    body: JSON.stringify({ query, limit })
  });
}

export function getHits(query: string, step = "1m") {
  return request<{ values?: Array<Record<string, unknown>> }>("/api/hits", {
    method: "POST",
    body: JSON.stringify({ query, step })
  });
}

export function getFields(query: string) {
  const params = new URLSearchParams({ query });
  return request<{ values?: ValueHit[] }>(`/api/fields?${params.toString()}`);
}

export function getFieldValues(query: string, field: string) {
  const params = new URLSearchParams({ query, field, limit: "25" });
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
