# Security Policy

## Supported Versions

Security fixes are handled on the `main` branch until a formal release policy is published.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories for the repository.

Do not open a public issue for vulnerabilities involving authentication bypass, credential exposure, log data exposure, prompt injection against MCP tools, or unauthorized access to VictoriaLogs.

## Deployment Security

Hikari does not provide end-user authentication. Protect the UI, API, and MCP endpoint with your own access layer or keep the service on an internal network.

The MCP endpoint can query logs and should be treated as a privileged operational interface.

