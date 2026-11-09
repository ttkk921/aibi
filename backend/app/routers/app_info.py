"""Branding, menu and AI examples of this deployment, so the frontend has nothing business-specific."""
from fastapi import APIRouter, Depends

from ..auth import require_user
from ..package import PACKAGE

router = APIRouter(prefix="/api/app", tags=["app"])


@router.get("/public")
def public_info():
    """Shown on the login page, before signing in."""
    return {"title": PACKAGE.title, "subtitle": PACKAGE.subtitle}


@router.get("", dependencies=[Depends(require_user)])
def app_info():
    return {
        "title": PACKAGE.title,
        "subtitle": PACKAGE.subtitle,
        "package": PACKAGE.name,
        "groups": [{"id": g.id, "title": g.title} for g in PACKAGE.groups],
        "reports": [{"id": r.id, "title": r.title, "type": r.type, "group": r.group} for r in PACKAGE.reports.values()],
        "chat_examples": PACKAGE.chat_examples,
    }
