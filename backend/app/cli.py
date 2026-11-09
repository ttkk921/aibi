"""Command-line tasks for a deployment.

    python -m app.cli setup                     # initialize / upgrade: database, schema, admin, read-only account
    python -m app.cli migrate                   # apply pending schema files of the business package
    python -m app.cli set-password [user]       # reset a user's password (default: first admin)
    python -m app.cli add-user <user> <role>    # create a user: viewer | analyst | admin
    python -m app.cli agent-token [file]        # new token for /api/agent (written to file, hash to .env)
    python -m app.cli rebuild-summaries         # recompute every derived column and summary table

All of them can be re-run; setup skips what is already in place.
"""
import hashlib
import os
import secrets
import sys
from getpass import getpass
from pathlib import Path

from .passwords import hash_password

ENV = Path(__file__).resolve().parent.parent / ".env"
PASSWORD_FILE = Path.home() / ".bi_admin_password"


def _read_env() -> dict[str, str]:
    if not ENV.exists():
        return {}
    out = {}
    for line in ENV.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def _write_env(values: dict[str, str]):
    # Keep mode/owner of an existing file (on the server it is root:bi 0640 so the service can read it).
    old = ENV.stat() if ENV.exists() else None
    ENV.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    if old is None:
        ENV.chmod(0o600)
        return
    ENV.chmod(old.st_mode & 0o777)
    if os.geteuid() == 0:
        os.chown(ENV, old.st_uid, old.st_gid)


def _write_secrets(values: dict[str, str]):
    """Persist generated settings in <data dir>/secrets.env (0600), merged with what is there."""
    from . import config

    path = config.SECRETS_FILE
    current = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                current[k.strip()] = v.strip()
    current.update(values)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("# Written by `python -m app.cli setup`; keep it private.\n")
        f.write("".join(f"{k}={v}\n" for k, v in current.items()))
    for k, v in values.items():
        os.environ[k] = v


def setup():
    """Bring a deployment up to date; safe to run on every start."""
    from . import config

    if not config.SECRET_KEY:
        _write_secrets({"SECRET_KEY": secrets.token_urlsafe(32)})
        print("已生成 SECRET_KEY")

    from . import dbsetup

    try:
        if dbsetup.create_database():
            print(f"已创建数据库 {config.DB_NAME}")
    except Exception as e:  # noqa: BLE001 - an existing database may simply not allow CREATE
        print(f"没有创建数据库（{e}）；如果库已存在可忽略")

    from .migrate import migrate

    if not migrate():
        print("表结构已是最新")

    from . import users

    password = users.bootstrap()
    if password:
        print(f"已创建管理员 {config.ADMIN_USER}，初始密码：{password}")
        print(f"（也保存在 {users.INITIAL_PASSWORD_FILE}，登录后请在右上角「修改密码」，并删除这个文件）")

    try:
        created = dbsetup.ensure_readonly_user()
        if created:
            _write_secrets(created)
            print(f"已创建只读账号 {created['AGENT_DB_USER']}（AI 写 SQL 用），凭据保存在 {config.SECRETS_FILE}")
        else:
            print(f"只读账号 {config.AGENT_DB_USER} 已存在，已按业务包更新授权")
    except Exception as e:  # noqa: BLE001
        print(f"没能创建只读账号（{e}）。AI 问数仍可查报表，但不能写 SQL；")
        print("  可以设置有 CREATE USER 权限的 DB_ADMIN_USER / DB_ADMIN_PASSWORD 后重新运行 setup")

    from .db import query
    from .derived import fill_empty
    from .summaries import SUMMARIES, rebuild_all

    for col, n in fill_empty().items():
        if n:
            print(f"{col}：补算 {n} 行")

    # Imports keep summaries current; fill them only when empty (e.g. data loaded before the summary existed).
    empty = [s for s in SUMMARIES.values() if not query(f"select exists(select 1 from `{s.table}`)")[1][0][0]]
    if empty and any(query(f"select exists(select 1 from `{s.source}`)")[1][0][0] for s in empty):
        for table, n in rebuild_all().items():
            print(f"汇总表 {table}：{n} 行")
    print("完成")


def migrate_cmd():
    from .migrate import migrate

    if not migrate():
        print("表结构已是最新")


def set_password():
    """Reset a user's password from the server (forgotten password). Default user: the first admin."""
    from . import users

    users.bootstrap()
    name = sys.argv[2] if len(sys.argv) > 2 else None
    user = users.by_username(name) if name else next((u for u in users.all_users() if u.role == "admin"), None)
    if user is None:
        sys.exit(f"没有用户 {name}")
    p1 = getpass(f"{user.username} 的新密码：")
    if len(p1) < 8:
        sys.exit("密码至少 8 位")
    if getpass("再输一次：") != p1:
        sys.exit("两次输入不一致")
    users.set_password(user.id, hash_password(p1))
    if not user.active:
        users.update(user.id, active=True)
    PASSWORD_FILE.unlink(missing_ok=True)
    print(f"{user.username} 的密码已更新（账号已启用），他已有的登录全部失效")


def add_user():
    """Create a user from the server: add-user <username> <viewer|analyst|admin>."""
    from . import users

    users.bootstrap()
    if len(sys.argv) < 4 or sys.argv[3] not in users.ROLES:
        sys.exit("用法：python -m app.cli add-user <用户名> <viewer|analyst|admin>")
    name, role = sys.argv[2], sys.argv[3]
    if users.by_username(name):
        sys.exit(f"用户 {name} 已存在")
    p1 = getpass(f"{name} 的密码：")
    if len(p1) < 8:
        sys.exit("密码至少 8 位")
    if getpass("再输一次：") != p1:
        sys.exit("两次输入不一致")
    users.create(name, name, role, hash_password(p1))
    print(f"已创建 {name}（{users.ROLE_LABELS[role]}）")


def agent_token():
    """Replace the agent API token. Only its hash is kept in .env; the token goes to a 0600 file."""
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home() / ".bi_agent_token"
    token = secrets.token_urlsafe(32)
    env = _read_env()
    env["AGENT_TOKEN_HASH"] = hashlib.sha256(token.encode()).hexdigest()
    _write_env(env)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    os.chmod(out, 0o600)
    print(f"新 token 已写入 {out}（仅文件所有者可读），旧 token 失效；重启服务后生效")


def rebuild_summaries():
    from . import derived
    from .summaries import rebuild_all

    for col, n in derived.rebuild_all().items():
        print(f"{col}: {n} 行")
    for table, n in rebuild_all().items():
        print(f"{table}: {n} 行")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {
        "setup": setup,
        "init": setup,  # old name
        "migrate": migrate_cmd,
        "set-password": set_password,
        "add-user": add_user,
        "agent-token": agent_token,
        "rebuild-summaries": rebuild_summaries,
    }.get(cmd, lambda: sys.exit(__doc__))()
