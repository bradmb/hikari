FROM node:24-alpine AS web

WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web ./
ENV VITE_API_BASE_URL=""
RUN npm run build

FROM python:3.13-slim

WORKDIR /app
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api/hikari_api ./hikari_api
COPY --from=web /web/dist ./web

ENV HIKARI_VICTORIA_URL="http://localhost:9428"
CMD ["uvicorn", "hikari_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
