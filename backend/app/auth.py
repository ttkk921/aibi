"""Login with per-user accounts (users.py) and a signed session cookie.

The session holds the user's id and the epoch it was issued with; every request reloads the
user, so disabling an account, changing a role or resetting a password takes effect at once.
Routers declare the least role they need with `require_role("analyst")` etc.
"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import users
from .passwords import hash_password, verify_password
from .users import User

router = APIRouter(prefix="/api/auth", tags=["auth"])

_MAX_FAILS = 5
_LOCK_SECONDS = 15 * 60
_fails: dict[str, list[float]] = {}
# Compared against when the username is unknown, so a wrong name costs as much as a wrong password.
_DUMMY_HASH = hash_password("not-a-real-password")

MIN_PASSWORD = 8


def _check_rate(request: Request) -> tuple[str, list[float]]:
    ip = request.client.host if request.client else "?"
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < _LOCK_SECONDS]
    if len(recent) >= _MAX_FAILS:
        raise HTTPException(status_code=429, detail="失败次数过多，请 15 分钟后再试")
    return ip, recent


def require_user(request: Request) -> User:
    uid = request.session.get("uid")
    user = users.get(uid) if isinstance(uid, int) else None
    if user is None or not user.active or request.session.get("epoch") != user.epoch:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def require_role(role: str):
    """Dependency: a signed-in user with at least `role`."""

    def check(user: User = Depends(require_user)) -> User:
        if not user.at_least(role):
            raise HTTPException(status_code=403, detail="没有权限，请联系管理员")
        return user

    return check


def permissions(user: User) -> dict:
    """What the frontend may show; the API enforces the same rules."""
    return {
        "tables": user.at_least("analyst"),
        "import": user.at_least("analyst"),
        "sql": user.at_least("analyst"),
        "ai_sql": user.at_least("analyst"),
        "users": user.at_least("admin"),
    }


def _me(user: User) -> dict:
    return {**user.public(), "user": user.username, "permissions": permissions(user)}


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginIn, request: Request):
    ip, recent = _check_rate(request)
    user = users.by_username(body.username.strip())
    ok = verify_password(body.password, user.password_hash if user else _DUMMY_HASH) and user is not None
    if not ok:
        _fails[ip] = recent + [time.time()]
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not user.active:
        raise HTTPException(status_code=403, detail="账号已停用，请联系管理员")
    _fails.pop(ip, None)
    users.touch_login(user.id)
    request.session.clear()
    request.session["uid"] = user.id
    request.session["epoch"] = user.epoch
    return _me(user)


@router.post("/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(require_user)):
    return _me(user)


class PasswordIn(BaseModel):
    old_password: str
    new_password: str


@router.post("/password")
def change_password(body: PasswordIn, request: Request, user: User = Depends(require_user)):
    ip, recent = _check_rate(request)
    if not verify_password(body.old_password, user.password_hash):
        _fails[ip] = recent + [time.time()]
        raise HTTPException(status_code=400, detail="当前密码不对")
    if len(body.new_password) < MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"新密码至少 {MIN_PASSWORD} 位")
    if body.new_password == body.old_password:
        raise HTTPException(status_code=400, detail="新密码不能和当前密码相同")
    updated = users.set_password(user.id, hash_password(body.new_password))
    _fails.pop(ip, None)
    # This session stays signed in; the user's other sessions no longer match the epoch.
    request.session["epoch"] = updated.epoch
    return {"ok": True}
