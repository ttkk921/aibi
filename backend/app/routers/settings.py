"""Settings admins change on the AI 设置 page: providers, the model AI 问数 uses, and its prompt (role and answer style)."""
import re
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import ai_providers as ai
from .. import settings
from ..auth import require_role
from ..package import PACKAGE
from ..users import User
from .chat import FALLBACK_STYLE, PLATFORM_RULES, STYLE_KEY

router = APIRouter(prefix="/api/settings", tags=["settings"])
admin_only = require_role("admin")

MAX_STYLE = 10000


def _style_state() -> dict:
    saved = settings.get(STYLE_KEY)
    default = PACKAGE.chat_style or FALLBACK_STYLE
    return {
        "style": saved["value"] if saved else default,
        "default": default,
        "customized": saved is not None,
        "updated_at": saved["updated_at"] if saved else None,
        "updated_by": saved["updated_by"] if saved else None,
        # Shown read-only so admins know what they do not need to (and cannot) change.
        "platform_rules": PLATFORM_RULES,
    }


@router.get("/chat-style")
def get_chat_style(_: User = Depends(admin_only)):
    return _style_state()


class StyleIn(BaseModel):
    style: str


@router.put("/chat-style")
def save_chat_style(body: StyleIn, user: User = Depends(admin_only)):
    style = body.style.strip()
    if not style:
        raise HTTPException(400, "风格说明不能为空；想用默认风格请点「恢复默认」")
    if len(style) > MAX_STYLE:
        raise HTTPException(400, f"风格说明最多 {MAX_STYLE} 字")
    settings.put(STYLE_KEY, style, user.username)
    return _style_state()


@router.delete("/chat-style")
def reset_chat_style(_: User = Depends(admin_only)):
    settings.delete(STYLE_KEY)
    return _style_state()


# ---------------------------------------------------------------- providers and model


def _mask(key: str) -> str | None:
    # Never send a key back to the browser, only enough to tell which one is in use.
    return f"{key[:5]}…{key[-4:]}" if len(key) > 12 else ("…" if key else None)


def _changed(key: str) -> dict:
    saved = settings.get(key)
    return {"at": saved["updated_at"], "by": saved["updated_by"]} if saved else None


def _ai_state() -> dict:
    provider, model = ai.selected()
    return {
        "providers": [
            {"id": p["id"], "name": p["name"], "base_url": p["base_url"], "models": p["models"], "api_key": _mask(p["api_key"])}
            for p in ai.providers()
        ],
        "selected": {"provider": provider["id"] if provider else None, "model": model},
        "providers_changed": _changed(ai.PROVIDERS_KEY),
        "model_changed": _changed(ai.SELECTED_KEY),
    }


def _try_model(base_url: str, api_key: str, model: str, what: str):
    """One tiny request, so a typo never breaks AI 问数 for everyone."""
    try:
        r = httpx.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 1},
            timeout=60,
        )
    except httpx.HTTPError as e:
        raise HTTPException(400, f"连不上 {base_url}，{what}：{e!r}")
    if r.status_code != 200:
        hint = {401: "key 无效", 403: "没有这个模型的权限", 404: "地址或模型名不对", 429: "请求太频繁或额度用完"}.get(r.status_code, "")
        raise HTTPException(400, f"用 {model} 测试返回 {r.status_code}{('（' + hint + '）') if hint else ''}，{what}：{r.text[:200]}")


@router.get("/ai")
def get_ai(_: User = Depends(admin_only)):
    return _ai_state()


@router.delete("/ai")
def reset_ai(_: User = Depends(admin_only)):
    ai.reset()
    return _ai_state()


class ProviderIn(BaseModel):
    name: str
    base_url: str
    api_key: str = ""  # empty when editing = keep the saved key
    models: list[str]


@router.put("/ai/providers/{provider_id}")
def save_provider(provider_id: str, body: ProviderIn, user: User = Depends(admin_only)):
    """provider_id "new" adds one. The key and the first model (or the one in use) are tried before saving."""
    items = ai.providers()
    old = next((p for p in items if p["id"] == provider_id), None)
    if provider_id != "new" and not old:
        raise HTTPException(404, "没有这个 provider，刷新页面再试")
    name, base_url, key = body.name.strip(), body.base_url.strip().rstrip("/"), body.api_key.strip()
    models = list(dict.fromkeys(m.strip() for m in body.models if m.strip()))
    if not name:
        raise HTTPException(400, "名称不能为空")
    if any(p["name"] == name and p is not old for p in items):
        raise HTTPException(400, f"已经有叫「{name}」的 provider")
    if not re.match(r"^https?://\S+$", base_url):
        raise HTTPException(400, "接口地址要以 http:// 或 https:// 开头，例如 https://api.commandcode.ai/provider/v1")
    if len(key) > 500 or any(c.isspace() for c in key):
        raise HTTPException(400, "key 格式不对（不能有空格或换行）")
    key = key or (old["api_key"] if old else "")
    if not key:
        raise HTTPException(400, "请填写 key")
    if not models:
        raise HTTPException(400, "至少填一个模型")
    in_use, model = ai.selected()
    using = old is not None and in_use is not None and in_use["id"] == old["id"] and model in models
    _try_model(base_url, key, model if using else models[0], "没有保存")
    p = {"id": old["id"] if old else uuid.uuid4().hex[:8], "name": name, "base_url": base_url, "api_key": key, "models": models}
    ai.save_providers([p if x is old else x for x in items] if old else items + [p], user.username)
    return _ai_state()


@router.delete("/ai/providers/{provider_id}")
def delete_provider(provider_id: str, user: User = Depends(admin_only)):
    items = ai.providers()
    if not any(p["id"] == provider_id for p in items):
        raise HTTPException(404, "没有这个 provider，刷新页面再试")
    in_use, _ = ai.selected()
    if in_use and in_use["id"] == provider_id:
        raise HTTPException(400, "AI 问数正在用这个 provider 的模型，先在「选择模型」换成别的")
    ai.save_providers([p for p in items if p["id"] != provider_id], user.username)
    return _ai_state()


class ModelIn(BaseModel):
    provider: str
    model: str


@router.put("/ai/model")
def save_model(body: ModelIn, user: User = Depends(admin_only)):
    p = next((p for p in ai.providers() if p["id"] == body.provider), None)
    if not p or body.model not in p["models"]:
        raise HTTPException(400, "没有这个模型，刷新页面再试")
    _try_model(p["base_url"], p["api_key"], body.model, "没有切换")
    ai.select(p["id"], body.model, user.username)
    return _ai_state()
