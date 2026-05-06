# Hikari

Hikari is an open source log investigation UI for VictoriaLogs. It combines a fast log explorer, faceted discovery, natural-language LogsQL generation, and a Streamable HTTP MCP server so humans and AI tools can investigate production logs with the same workflow.

## Features

- VictoriaLogs search, facets, field discovery, hit counts, and live tail.
- Natural-language search that generates editable LogsQL with evidence.
- MCP tools for agents: instructions, summaries, raw queries, AI search, fields, field values, facets, hits, and bounded tail samples.
- Single production container that serves the FastAPI API and built web UI.
- Local Docker Compose setup with a mock VictoriaLogs backplane for UI development.

## Quick Start

```powershell
Copy-Item .env.example .env
docker compose up mock-victorialogs api web
```

The development UI runs at `http://localhost:5173` and proxies API calls to `http://localhost:8000`.

To run the combined production-style image locally:

```powershell
docker compose up hikari
```

Then open `http://localhost:8000`.

## Configuration

Common environment variables:

- `HIKARI_VICTORIA_URL`: VictoriaLogs base URL.
- `HIKARI_VICTORIA_BEARER_TOKEN`: optional bearer token for VictoriaLogs.
- `HIKARI_VICTORIA_HEADERS`: optional JSON object of extra headers for VictoriaLogs.
- `HIKARI_DEFAULT_QUERY`: default LogsQL query, usually `_time:15m`.
- `HIKARI_DEFAULT_FIELDS`: comma-separated fields to surface in the UI.
- `OPENAI_API_KEY`: optional, enables natural-language query generation.
- `HIKARI_OPENAI_MODEL`: model used for natural-language query generation.

AWS Secrets Manager variants are supported for deployments that load secrets at runtime:

- `HIKARI_VICTORIA_BEARER_TOKEN_SECRET_ID`
- `HIKARI_VICTORIA_HEADERS_SECRET_ID`
- `HIKARI_OPENAI_API_KEY_SECRET_ID`

## MCP

Hikari exposes MCP over Streamable HTTP:

```text
http://localhost:8000/mcp
```

HTTP transport is the correct MCP transport type. See the static MCP documentation in `docs/mcp.html` for tool descriptions and example calls.

## Authentication

Hikari does not include end-user authentication or authorization. The safest deployment is to keep Hikari off the public Internet and expose it only on an internal network. If you need external access, put the UI, API, and MCP endpoint behind your own access layer, such as Cloudflare Access, Tailscale, Teleport, OAuth2 Proxy, Pomerium, an SSO-aware reverse proxy, a VPN, or an identity-aware ingress gateway.

The MCP endpoint can query logs and should be protected with the same care as the UI and API.

## Documentation

- `INSTALLATION.md`: local and Kubernetes installation guide.
- `docs/installation.html`: static installation documentation page.
- `docs/index.html`: GitHub Pages landing page.
- `docs/mcp.html`: static MCP documentation page.

## Checks

```powershell
npm --prefix web run build
python -m compileall api
$env:PYTHONPATH="$PWD\api"; python -m pytest api\tests
docker build -t hikari:local .
node --check docs\logs.js
helm lint k8s\helm\hikari
```

## License

Hikari is licensed under the MIT License. See `LICENSE`.
