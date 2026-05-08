# Hikari Installation

This guide covers local development and Kubernetes deployment. Hikari expects you to provide a VictoriaLogs backend and, for exposed deployments, your own authentication layer.

## Local Development

Prerequisites:

- Docker Desktop or compatible Docker Engine.
- Node.js only if you want to run the web app outside Docker.
- Python only if you want to run the API outside Docker.

Create local configuration:

```powershell
Copy-Item .env.example .env
```

Run the mock VictoriaLogs backend, API, and Vite UI:

```powershell
docker compose up mock-victorialogs api web
```

Open:

```text
http://localhost:5173
```

The local web container proxies API requests to:

```text
http://localhost:8000
```

The mock VictoriaLogs service is available at:

```text
http://localhost:9428
```

## Local Production-Style Container

Build and run the combined image locally:

```powershell
docker compose up hikari
```

Open:

```text
http://localhost:8000
```

This serves the FastAPI API and the built web UI from one process.

## Prebuilt Container Image

The OSS repository publishes a multi-architecture image to GitHub Container Registry:

```text
ghcr.io/bradmb/hikari:latest
```

`latest` follows the `main` branch. Version tags are published from Git tags that match `v*.*.*`, and each build also gets a `sha-...` tag. For production deployments, pin a version tag or SHA tag instead of `latest`.

Run the image directly:

```powershell
docker run --rm -p 8000:8000 `
  -e HIKARI_VICTORIA_URL=https://victorialogs.example.com `
  ghcr.io/bradmb/hikari:latest
```

## Using A Real VictoriaLogs Backend

Set `HIKARI_VICTORIA_URL` in `.env`:

```env
HIKARI_VICTORIA_URL=https://victorialogs.example.com
```

If VictoriaLogs requires authentication, provide either a bearer token:

```env
HIKARI_VICTORIA_BEARER_TOKEN=replace-me
```

or extra headers as JSON:

```env
HIKARI_VICTORIA_HEADERS={"X-Example-Header":"replace-me"}
```

Keep secrets out of committed files.

## Field Mappings

Hikari resolves display columns, facets, MCP summaries, and hidden query alias expansion from `config/field-mappings.json`. This file is the place to adapt Hikari to your log schema.

Set `HIKARI_FACET_PREVIEW_LIMIT` to control how many values each facet shows before the UI displays a `View more` expander. The default is `10`.

The mapping has three parts:

- `defaultFields`: fields shown first in manual field selectors and field discovery.
- `aliases`: source fields that should populate a canonical Hikari field.
- `facets`: the facet groups shown in the left sidebar and MCP summaries.

Use `aliases` to map your log schema into canonical fields. The first item can be the canonical field itself, followed by every source field that may contain the same value:

```json
{
  "aliases": {
    "service": ["service", "service.name", "service_name", "app", "kubernetes.container_name"],
    "host": ["host", "host.name", "host_name", "hostname", "kubernetes.pod_node_name"]
  }
}
```

Hikari applies these aliases to backend VictoriaLogs requests with hidden LogsQL
`copy` pipes. Users still see and share the clean canonical query, such as
`_time:15m service:="api"`, while Hikari sends the configured copies when it
loads rows, facets, field values, hit buckets, live tail data, and MCP results.

For example, with the mapping above, a visible query like:

```text
_time:15m
```

is sent to VictoriaLogs with generated copies similar to:

```text
_time:15m | copy service.name as service | copy service_name as service | copy host.name as host | copy host_name as host
```

Do not add these copy pipes manually to user-facing saved queries. Configure the
facet aliases once and let Hikari add them consistently.

Use `derivedFields` for canonical values that are embedded inside another field instead of stored as a
top-level field. Hikari uses these rules for row display, level facets, and histogram level breakdowns.
Regex rules are translated into LogsQL regex clauses so VictoriaLogs still performs the matching work.

```json
{
  "derivedFields": {
    "level": [
      { "type": "json", "sources": ["_msg", "message", "msg", "log"], "path": "level" },
      { "type": "regex", "sources": ["_msg", "message", "msg", "log"], "pattern": "\"level\"\\s*:\\s*\"error\"", "queryPattern": "\\x22level\\x22[[:space:]]*:[[:space:]]*\\x22error\\x22", "flags": "i", "value": "error" },
      { "type": "regex", "sources": ["_msg", "message", "msg", "log"], "pattern": "^W\\d{4}\\s+\\d{2}:\\d{2}:\\d{2}", "value": "warning" },
      {
        "type": "regex",
        "sources": ["_msg", "message", "msg", "log"],
        "pattern": "\\bHTTP/\\d(?:\\.\\d)?\\s+5\\d\\d\\b",
        "queryPattern": "HTTP/[0-9]([.][0-9])?[[:space:]]+5[0-9][0-9]",
        "flags": "i",
        "value": "error"
      }
    ]
  }
}
```

The optional `flags` value currently supports `i` for case-insensitive regex handling. If a regex needs
different syntax for VictoriaLogs than for local row normalization, set `queryPattern`; Hikari uses
`queryPattern` for LogsQL and `pattern` for Python/JavaScript row normalization.

Use `facets` to choose the canonical fields shown in the left sidebar and MCP summary output:

```json
{
  "facets": [
    { "field": "environment", "label": "Environment" },
    { "field": "service", "label": "Service", "summary": true },
    { "field": "host", "label": "Host", "summary": true },
    { "field": "level", "label": "Level", "summary": true },
    { "field": "kubernetes.pod_namespace", "key": "namespace", "label": "Namespace", "summary": true },
    { "field": "kubernetes.pod_name", "key": "pod", "label": "Pod", "summary": true }
  ]
}
```

Each facet `field` is the canonical field Hikari displays and filters on. The `key` is optional and provides a shorter MCP summary key. Set `summary: true` for facets that should appear in MCP `summarize_window` and default `get_facets` output.

In Kubernetes, the Helm chart mounts this JSON through a ConfigMap generated from `fieldMappings.config`.
The chart sets `HIKARI_FIELD_MAPPINGS_FILE` to `/app/config/field-mappings.json`, so the mounted ConfigMap
becomes the active mapping file.

Create a values file for your schema:

```yaml
fieldMappings:
  enabled: true
  config:
    defaultFields:
      - environment
      - service
      - service_name
      - host
      - host_name
      - level
      - kubernetes.pod_namespace
      - kubernetes.pod_name
    aliases:
      service:
        - service
        - service.name
        - service_name
        - kubernetes.container_name
      host:
        - host
        - host.name
        - host_name
        - hostname
        - kubernetes.pod_node_name
      level:
        - level
        - severity_text
    derivedFields:
      level:
        - type: json
          sources: [_msg, message, msg, log]
          path: level
        - type: regex
          sources: [_msg, message, msg, log]
          pattern: '"level"\s*:\s*"error"'
          queryPattern: '\x22level\x22[[:space:]]*:[[:space:]]*\x22error\x22'
          flags: i
          value: error
        - type: regex
          sources: [_msg, message, msg, log]
          pattern: '^W\d{4}\s+\d{2}:\d{2}:\d{2}'
          value: warning
    facets:
      - field: environment
        label: Environment
      - field: service
        label: Service
        summary: true
      - field: host
        label: Host
        summary: true
      - field: level
        label: Level
        summary: true
      - field: kubernetes.pod_namespace
        key: namespace
        label: Namespace
        summary: true
      - field: kubernetes.pod_name
        key: pod
        label: Pod
        summary: true
```

Apply it with Helm:

```powershell
helm upgrade --install hikari ./k8s/helm/hikari `
  --namespace hikari `
  --create-namespace `
  --values ./hikari-values.yaml `
  --set image.repository=ghcr.io/bradmb/hikari `
  --set-string image.tag=latest `
  --set env.facetPreviewLimit=10 `
  --set env.victoriaUrl=http://victorialogs.example.svc:9428
```

For non-Helm deployments, set `HIKARI_FIELD_MAPPINGS_FILE` to a mounted JSON file. `HIKARI_FIELD_MAPPINGS` can provide inline JSON overrides when a file mount is inconvenient.

## Optional AI Search

Natural-language search requires an OpenAI API key:

```env
OPENAI_API_KEY=replace-me
HIKARI_OPENAI_MODEL=gpt-5.4-mini
```

Without `OPENAI_API_KEY`, the regular log explorer and MCP non-AI tools can still run.

If your MCP endpoint is exposed through a reverse proxy and you want MCP host
header validation, set the public host names:

```env
HIKARI_MCP_ALLOWED_HOSTS=logs.example.com
```

## MCP Endpoint

Hikari exposes MCP over Streamable HTTP:

```text
http://localhost:8000/mcp
```

Use HTTP transport in MCP clients. A good first test is to list tools and call `get_instructions`.

Common tools:

- `get_instructions`
- `summarize_window`
- `query_logs`
- `ai_search`
- `get_facets`
- `get_fields`
- `get_field_values`
- `get_hits`
- `tail_logs`

## Bring Your Own Authentication

Hikari does not provide end-user authentication or authorization.

The safest deployment is to keep Hikari off the public Internet and expose it only on an internal network.

If you need external access, put the UI, API, and MCP endpoint behind your own access layer. Common options include:

- Cloudflare Access or another identity-aware proxy.
- Tailscale, WireGuard, or a private VPN.
- Teleport application access.
- OAuth2 Proxy in front of an ingress controller.
- Pomerium or another SSO-aware reverse proxy.
- A cloud provider private application gateway or load balancer with identity controls.

Protect MCP access the same way you protect the UI. MCP tools can query logs, discover fields, and return operational data.

## Kubernetes Deployment

Prerequisites:

- A Kubernetes cluster.
- A container registry.
- A reachable VictoriaLogs backend from inside the cluster.
- An external authentication layer for exposed deployments.

Build and publish an image:

```powershell
docker build -t registry.example.com/hikari:latest .
docker push registry.example.com/hikari:latest
```

Deploy with the included Helm chart, overriding image and VictoriaLogs settings:

```powershell
helm upgrade --install hikari ./k8s/helm/hikari `
  --namespace hikari `
  --create-namespace `
  --set image.repository=ghcr.io/bradmb/hikari `
  --set-string image.tag=latest `
  --set env.victoriaUrl=http://victorialogs.example.svc:9428
```

If you use AWS Secrets Manager for the OpenAI key, set:

```powershell
--set env.openAiSecretId=kubernetes/hikari/openai
```

Otherwise, adapt the chart or deployment environment to inject `OPENAI_API_KEY` directly from your secret manager of choice.

Verify rollout:

```powershell
kubectl -n hikari rollout status deployment/hikari
kubectl -n hikari get pods
kubectl -n hikari port-forward deployment/hikari 8000:8000
```

Then check:

```text
http://localhost:8000/health
http://localhost:8000/mcp
```

## Deployment Targets

Hikari is a Python/FastAPI application packaged as a container. Deploy it on a container platform, VM, or Kubernetes cluster.

## Troubleshooting

- `GET /health` should return the active VictoriaLogs URL and default query.
- If searches fail, confirm `HIKARI_VICTORIA_URL` is reachable from the API container or pod.
- If MCP clients cannot fetch capabilities, confirm they are using HTTP transport and the `/mcp` URL.
- If AI search fails, confirm `OPENAI_API_KEY` or `HIKARI_OPENAI_API_KEY_SECRET_ID` is configured.
- If deployed publicly, confirm your access layer forwards required MCP headers and does not block POST requests to `/mcp`.
