import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.sessions import SessionMiddleware

from . import auth, config, users
from .routers import agent, app_info, chat, imports, reports, sql, tables
from .routers import settings as settings_router
from .routers import users as users_router

# Agent and AI-chat queries go to the service log (docker compose logs app) for auditing.
for _name in ("bi.agent", "bi.chat"):
    _log = logging.getLogger(_name)
    _log.setLevel(logging.INFO)
    if not _log.handlers:
        _h = logging.StreamHandler()
        _h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
        _log.addHandler(_h)


class ImmutableStatic(StaticFiles):
    """Vite puts a content hash in asset filenames, so they can be cached forever."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if resp.status_code == 200:
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


if not config.SECRET_KEY:
    raise RuntimeError("缺少 SECRET_KEY：先运行 python -m app.cli setup")

app = FastAPI(title="BI 看板", docs_url="/api/docs", openapi_url="/api/openapi.json")
# The server's outbound bandwidth is small; JSON, JS and CSV compress 5-10x.
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    SessionMiddleware,
    secret_key=config.SECRET_KEY,
    session_cookie="bi_session",
    max_age=7 * 24 * 3600,
    same_site="strict",
    https_only=config.COOKIE_SECURE,
)

# Accounts live in data/app.db; the first start migrates the single admin of the old setup.
users.bootstrap()

for r in (
    auth.router,
    users_router.router,
    settings_router.router,
    app_info.router,
    tables.router,
    imports.router,
    reports.router,
    sql.router,
    agent.router,
    chat.router,
):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"ok": True}


# Serve the built frontend; any non-API path falls back to index.html (client-side routing).
if config.WEB_DIST.exists():
    app.mount("/assets", ImmutableStatic(directory=config.WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str, request: Request):
        if path.startswith("api/"):
            raise HTTPException(404)
        f = config.WEB_DIST / path
        if path and f.is_file() and f.resolve().is_relative_to(config.WEB_DIST.resolve()):
            return FileResponse(f)
        # index.html must not be cached, or a deploy would keep serving old asset names.
        return FileResponse(config.WEB_DIST / "index.html", headers={"Cache-Control": "no-cache"})
else:

    @app.get("/", include_in_schema=False)
    def no_frontend():
        return JSONResponse({"detail": "前端还没有构建：cd web && npm run build"}, status_code=503)
