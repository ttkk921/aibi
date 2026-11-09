# BI + AI 看板：一个镜像包含后端、构建好的前端和业务包。
# 构建参数可以换成国内源，见 deploy/docker/.env.example。
ARG NODE_IMAGE=node:22.11.0-alpine
ARG PYTHON_IMAGE=python:3.12.7-slim-bookworm

FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"
COPY web/ ./
RUN npm run build

FROM ${PYTHON_IMAGE}
ARG PIP_INDEX=https://pypi.org/simple
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    BI_DATA_DIR=/data \
    BI_WEB_DIST=/app/web/dist \
    BI_PACKAGE_DIR=/app/packages/retail
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -i "$PIP_INDEX" -r requirements.txt
COPY backend/app ./app
COPY packages /app/packages
COPY --from=web /web/dist /app/web/dist
COPY deploy/docker/entrypoint.sh /entrypoint.sh
RUN useradd --system --uid 10001 --home /data bi \
    && mkdir -p /data && chown bi:bi /data && chmod 0755 /entrypoint.sh
USER bi
VOLUME /data
EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
