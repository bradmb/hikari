(function () {
  const track = document.querySelector(".log-track");
  if (!track) return;

  const maxRows = 56;
  const intervalMs = 560;
  const services = [
    "hikari-api",
    "hikari-ui",
    "hikari-mcp",
    "auth-service",
    "payments",
    "collector",
    "router",
    "worker",
    "scheduler",
    "checkout-api",
    "notifications",
    "victorialogs"
  ];
  const namespaces = ["edge-staging", "checkout-production", "default", "observability", "payments-production"];
  const pods = ["api-7cbfcdb8f9", "worker-59b5c88c4", "auth-679df4d7d8", "router-85fbbf4c7d"];
  const levels = [
    { key: "info", weight: 52 },
    { key: "warning", weight: 26 },
    { key: "error", weight: 16 },
    { key: "debug", weight: 6 }
  ];
  const templates = {
    info: [
      "query completed hits={hits} step=1m cache={cache}",
      "accepted {rows} events from namespace {namespace}",
      "generated LogsQL from prompt=\"{prompt}\"",
      "facet selection namespace={namespace} level={level}",
      "tool={tool} rows={rows} duration_ms={latency}",
      "request completed path={path} status=200 latency_ms={latency}"
    ],
    warning: [
      "retrying request after upstream timeout client={client}",
      "queue depth exceeded threshold queue={queue} depth={depth}",
      "slow request method=POST path={path} latency_ms={slowLatency}",
      "job delayed duration={delay}s reason=rate_limit",
      "tail stream reconnected attempt={attempt}"
    ],
    error: [
      "login failed reason=invalid_token pod={pod}",
      "database connection refused namespace={namespace}",
      "token introspection failed issuer=legacy-auth status=503",
      "uncaught exception trace_id={trace}",
      "MCP query failed tool={tool} reason=backend_timeout"
    ],
    debug: [
      "matched route={path} latency_ms={latency} host={host}",
      "batch flushed bytes={bytes} rows={rows} duration_ms={latency}",
      "normalized field alias namespace=kubernetes.pod_namespace",
      "health probe completed status=ok duration_ms={latency}"
    ]
  };

  let tick = 0;

  function choice(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function weightedLevel() {
    const total = levels.reduce((sum, level) => sum + level.weight, 0);
    let cursor = Math.random() * total;
    for (const level of levels) {
      cursor -= level.weight;
      if (cursor <= 0) return level.key;
    }
    return "info";
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function timeValue() {
    const date = new Date();
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function token(name) {
    const values = {
      attempt: 2 + Math.floor(Math.random() * 6),
      bytes: 24000 + Math.floor(Math.random() * 120000),
      cache: choice(["warm", "partial", "miss"]),
      client: choice(["demo-shop", "mobile-app", "portal", "partner-api"]),
      delay: 8 + Math.floor(Math.random() * 48),
      depth: 80 + Math.floor(Math.random() * 320),
      hits: 120 + Math.floor(Math.random() * 9800),
      host: `node-${1 + Math.floor(Math.random() * 8)}.internal.example`,
      latency: 12 + Math.floor(Math.random() * 190),
      level: choice(["error", "warning", "info"]),
      namespace: choice(namespaces),
      path: choice(["/api/search", "/api/facets", "/orders", "/login", "/checkout", "/mcp"]),
      pod: choice(pods),
      prompt: choice(["summarize checkout errors", "find slow requests", "show webhook retries"]),
      queue: choice(["webhooks", "emails", "exports", "events"]),
      rows: 100 + Math.floor(Math.random() * 900),
      slowLatency: 900 + Math.floor(Math.random() * 2200),
      tool: choice(["query_logs", "summarize_window", "get_facets", "ai_search"]),
      trace: `01JZ${Math.random().toString(36).slice(2, 14).toUpperCase()}`
    };
    return values[name] ?? "";
  }

  function renderTemplate(template) {
    return template.replace(/\{([a-zA-Z]+)\}/g, (_match, name) => token(name));
  }

  function appendLog() {
    const level = weightedLevel();
    const row = document.createElement("div");
    row.className = `tail-row is-new sev-${level}`;

    const time = document.createElement("span");
    time.textContent = timeValue();

    const service = document.createElement("b");
    service.textContent = choice(services);

    const message = document.createElement("em");
    message.textContent = renderTemplate(choice(templates[level]));

    row.append(time, service, message);
    track.append(row);

    while (track.children.length > maxRows) {
      track.firstElementChild?.remove();
    }

    window.setTimeout(() => row.classList.remove("is-new"), 560);
    tick += 1;
  }

  while (track.children.length > maxRows) {
    track.firstElementChild?.remove();
  }

  window.setInterval(appendLog, intervalMs);
})();
