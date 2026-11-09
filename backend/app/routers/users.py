"""User management (admins only). Guards keep at least one active admin and stop an admin from
locking themselves out (no self-demotion, self-disable or self-delete)."""
import re
import secrets
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import users
from ..auth import MIN_PASSWORD, require_role
from ..passwords import hash_password
from ..users import ROLES, User

router = APIRouter(prefix="/api/users", tags=["users"])
admin_only = require_role("admin")

_USERNAME = re.compile(r"^[\w.@-]{2,32}$")


def _password(given: str | None) -> tuple[str, str | None]:
    """(password, generated) — a blank password gets a random one that is shown once."""
    if given:
        if len(given) < MIN_PASSWORD:
            raise HTTPException(400, f"密码至少 {MIN_PASSWORD} 位")
        return given, None
    generated = secrets.token_urlsafe(9)
    return generated, generated


def _target(user_id: int) -> User:
    user = users.get(user_id)
    if user is None:
        raise HTTPException(404, "没有这个用户")
    return user


def _keeps_an_admin(target: User, *, role: str | None = None, active: bool | None = None, deleting: bool = False):
    losing = target.role == "admin" and target.active and (deleting or (role not in (None, "admin")) or active is False)
    if losing and users.active_admins() <= 1:
        raise HTTPException(400, "至少要保留一个启用的管理员")


@router.get("")
def list_users(_: User = Depends(admin_only)):
    return [u.public() for u in users.all_users()]


class UserIn(BaseModel):
    username: str
    display_name: str = ""
    role: str = "viewer"
    password: str | None = None


@router.post("")
def create_user(body: UserIn, _: User = Depends(admin_only)):
    username = body.username.strip()
    if not _USERNAME.match(username):
        raise HTTPException(400, "用户名 2-32 位，只能用字母、数字、中文和 _ . @ -")
    if body.role not in ROLES:
        raise HTTPException(400, "角色不对")
    password, generated = _password(body.password)
    try:
        user = users.create(username, body.display_name.strip() or username, body.role, hash_password(password))
    except sqlite3.IntegrityError:
        raise HTTPException(400, f"用户名 {username} 已存在")
    return {"user": user.public(), "generated_password": generated}


class UserPatch(BaseModel):
    display_name: str | None = None
    role: str | None = None
    active: bool | None = None


@router.patch("/{user_id}")
def update_user(user_id: int, body: UserPatch, me: User = Depends(admin_only)):
    target = _target(user_id)
    if body.role is not None and body.role not in ROLES:
        raise HTTPException(400, "角色不对")
    if target.id == me.id and ((body.role not in (None, me.role)) or body.active is False):
        raise HTTPException(400, "不能修改自己的角色或停用自己")
    _keeps_an_admin(target, role=body.role, active=body.active)
    display = body.display_name.strip() if body.display_name is not None else None
    return users.update(user_id, display_name=display or None, role=body.role, active=body.active).public()


class ResetIn(BaseModel):
    password: str | None = None


@router.post("/{user_id}/password")
def reset_password(user_id: int, body: ResetIn, _: User = Depends(admin_only)):
    target = _target(user_id)
    password, generated = _password(body.password)
    users.set_password(target.id, hash_password(password))
    return {"ok": True, "generated_password": generated}


@router.delete("/{user_id}")
def delete_user(user_id: int, me: User = Depends(admin_only)):
    target = _target(user_id)
    if target.id == me.id:
        raise HTTPException(400, "不能删除自己")
    _keeps_an_admin(target, deleting=True)
    users.delete(target.id)
    return {"ok": True}
