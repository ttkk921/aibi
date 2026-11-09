"""AI providers and the model AI 问数 uses, managed by admins on the AI 设置 page and kept in data/app.db.

A provider is an OpenAI-compatible endpoint: {"id", "name", "base_url", "api_key", "models"}. Until an admin
saves a provider, the deployment's .env gives one (LLM_BASE_URL / LLM_API_KEY / LLM_MODELS)."""
import json
from urllib.parse import urlparse

from . import config, settings

PROVIDERS_KEY = "ai_providers"
SELECTED_KEY = "ai_model"
DEFAULT_ID = "default"
# What the earlier 问数设置 page saved: only read to build the initial configuration.
_OLD_MODEL_KEY = "chat_model"
_OLD_API_KEY_KEY = "chat_api_key"


def _env_providers() -> list[dict]:
    host = urlparse(config.LLM_BASE_URL).hostname or config.LLM_BASE_URL
    old_key = settings.get(_OLD_API_KEY_KEY)
    return [{
        "id": DEFAULT_ID,
        "name": "Command Code" if host.endswith("commandcode.ai") else host,
        "base_url": config.LLM_BASE_URL,
        "api_key": old_key["value"] if old_key else config.LLM_API_KEY,
        "models": list(config.LLM_MODELS),
    }]


def providers() -> list[dict]:
    saved = settings.get(PROVIDERS_KEY)
    return json.loads(saved["value"]) if saved else _env_providers()


def save_providers(items: list[dict], user: str):
    settings.put(PROVIDERS_KEY, json.dumps(items, ensure_ascii=False), user)


def select(provider_id: str, model: str, user: str):
    settings.put(SELECTED_KEY, json.dumps({"provider": provider_id, "model": model}), user)


def selected() -> tuple[dict | None, str]:
    """(provider, model) AI 问数 uses now. When the chosen one is gone, the first model of the first provider."""
    items = providers()
    saved = settings.get(SELECTED_KEY)
    if saved:
        want = json.loads(saved["value"])
    else:
        old = settings.get(_OLD_MODEL_KEY)
        want = {"provider": DEFAULT_ID, "model": old["value"] if old else config.LLM_MODEL}
    for p in items:
        if p["id"] == want["provider"] and want["model"] in p["models"]:
            return p, want["model"]
    return next(((p, p["models"][0]) for p in items if p["models"]), (None, ""))


def reset():
    """Back to what .env says."""
    for key in (PROVIDERS_KEY, SELECTED_KEY, _OLD_MODEL_KEY, _OLD_API_KEY_KEY):
        settings.delete(key)
