# Contributing

Thanks for contributing to Hikari.

## Local Development

Start the local stack:

```powershell
Copy-Item .env.example .env
docker compose up mock-victorialogs api web
```

The UI runs at `http://localhost:5173`.

## Checks

Run these before opening a pull request:

```powershell
npm --prefix web run build
python -m compileall api
$env:PYTHONPATH="$PWD\api"; python -m pytest api\tests
docker build -t hikari:local .
node --check docs\logs.js
```

If you touch the Helm chart, also run:

```powershell
helm lint k8s\helm\hikari
helm template hikari k8s\helm\hikari
```

## Pull Requests

- Keep changes focused.
- Include tests for API, MCP, parser, or query behavior changes.
- Keep deployment-specific configuration out of the public repository.
- Do not commit real logs, account IDs, access tokens, customer names, or private infrastructure details.

