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

## Optional AI Search

Natural-language search requires an OpenAI API key:

```env
OPENAI_API_KEY=replace-me
HIKARI_OPENAI_MODEL=gpt-5.4-mini
```

Without `OPENAI_API_KEY`, the regular log explorer and MCP non-AI tools can still run.

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
  --set image.repository=registry.example.com/hikari `
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
