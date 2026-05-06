from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated, Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    victoria_url: str = Field("http://localhost:9428", alias="HIKARI_VICTORIA_URL")
    victoria_bearer_token: str = Field("", alias="HIKARI_VICTORIA_BEARER_TOKEN")
    victoria_bearer_token_secret_id: str = Field(
        "",
        alias="HIKARI_VICTORIA_BEARER_TOKEN_SECRET_ID",
    )
    victoria_headers: dict[str, str] = Field(
        default_factory=dict,
        alias="HIKARI_VICTORIA_HEADERS",
    )
    victoria_headers_secret_id: str = Field(
        "",
        alias="HIKARI_VICTORIA_HEADERS_SECRET_ID",
    )
    default_query: str = Field("_time:15m", alias="HIKARI_DEFAULT_QUERY")
    default_fields: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["host", "service", "source", "level", "status", "environment", "client"],
        alias="HIKARI_DEFAULT_FIELDS",
    )
    field_mappings_file: str = Field("config/field-mappings.json", alias="HIKARI_FIELD_MAPPINGS_FILE")
    field_mappings: dict[str, Any] = Field(default_factory=dict, alias="HIKARI_FIELD_MAPPINGS")
    openai_api_key: str = Field("", alias="OPENAI_API_KEY")
    openai_api_key_secret_id: str = Field("", alias="HIKARI_OPENAI_API_KEY_SECRET_ID")
    openai_model: str = Field("gpt-5.4-mini", alias="HIKARI_OPENAI_MODEL")
    aws_region: str = Field("us-east-1", alias="AWS_REGION")
    request_timeout_seconds: float = Field(30.0, alias="HIKARI_REQUEST_TIMEOUT_SECONDS")
    mcp_allowed_hosts: Annotated[list[str], NoDecode] = Field(default_factory=list, alias="HIKARI_MCP_ALLOWED_HOSTS")

    @field_validator("victoria_headers", mode="before")
    @classmethod
    def parse_headers(cls, value: object) -> dict[str, str]:
        if value in (None, ""):
            return {}
        if isinstance(value, dict):
            return {str(key): str(header_value) for key, header_value in value.items()}
        if isinstance(value, str):
            parsed = json.loads(value)
            if not isinstance(parsed, dict):
                raise ValueError("HIKARI_VICTORIA_HEADERS must be a JSON object")
            return {str(key): str(header_value) for key, header_value in parsed.items()}
        raise ValueError("HIKARI_VICTORIA_HEADERS must be a JSON object")

    @field_validator("default_fields", mode="before")
    @classmethod
    def parse_default_fields(cls, value: object) -> list[str]:
        if isinstance(value, str):
            return [field.strip() for field in value.split(",") if field.strip()]
        if isinstance(value, list):
            return [str(field) for field in value]
        raise ValueError("HIKARI_DEFAULT_FIELDS must be a comma-separated string")

    @field_validator("field_mappings", mode="before")
    @classmethod
    def parse_field_mappings(cls, value: object) -> dict[str, Any]:
        if value in (None, ""):
            return {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            parsed = json.loads(value)
            if not isinstance(parsed, dict):
                raise ValueError("HIKARI_FIELD_MAPPINGS must be a JSON object")
            return parsed
        raise ValueError("HIKARI_FIELD_MAPPINGS must be a JSON object")

    @field_validator("mcp_allowed_hosts", mode="before")
    @classmethod
    def parse_mcp_allowed_hosts(cls, value: object) -> list[str]:
        if value in (None, ""):
            return []
        if isinstance(value, str):
            return [host.strip() for host in value.split(",") if host.strip()]
        if isinstance(value, list):
            return [str(host).strip() for host in value if str(host).strip()]
        raise ValueError("HIKARI_MCP_ALLOWED_HOSTS must be a comma-separated string")


def _read_secret(secret_id: str, region: str) -> str:
    try:
        client = boto3.client("secretsmanager", region_name=region)
        response = client.get_secret_value(SecretId=secret_id)
    except (BotoCoreError, ClientError) as exc:
        raise RuntimeError(f"Unable to read secret {secret_id}") from exc

    if "SecretString" in response:
        return response["SecretString"]
    secret_binary = response.get("SecretBinary", b"")
    if isinstance(secret_binary, bytes):
        return secret_binary.decode("utf-8")
    return str(secret_binary)


def _secret_value(secret_id: str, region: str, preferred_keys: tuple[str, ...]) -> str:
    raw = _read_secret(secret_id, region)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if not isinstance(parsed, dict):
        return raw
    for key in preferred_keys:
        value = parsed.get(key)
        if value:
            return str(value)
    return raw


def _optional_secret_value(secret_id: str, region: str, preferred_keys: tuple[str, ...]) -> str:
    try:
        return _secret_value(secret_id, region, preferred_keys)
    except RuntimeError:
        return ""


def _optional_secret_json(secret_id: str, region: str) -> dict[str, str]:
    try:
        raw = _read_secret(secret_id, region)
    except RuntimeError:
        return {}
    if not raw:
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("Secret must contain a JSON object")
    return {str(key): str(value) for key, value in parsed.items()}


@lru_cache
def get_settings() -> Settings:
    settings = Settings()

    if settings.victoria_bearer_token_secret_id and not settings.victoria_bearer_token:
        settings.victoria_bearer_token = _optional_secret_value(
            settings.victoria_bearer_token_secret_id,
            settings.aws_region,
            ("token", "bearer_token", "HIKARI_VICTORIA_BEARER_TOKEN"),
        )

    if settings.openai_api_key_secret_id and not settings.openai_api_key:
        settings.openai_api_key = _optional_secret_value(
            settings.openai_api_key_secret_id,
            settings.aws_region,
            ("api_key", "OPENAI_API_KEY", "HIKARI_OPENAI_API_KEY"),
        )

    if settings.victoria_headers_secret_id and not settings.victoria_headers:
        settings.victoria_headers = _optional_secret_json(settings.victoria_headers_secret_id, settings.aws_region)

    return settings
