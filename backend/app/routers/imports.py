"""Upload -> preview -> commit."""
import json
import re
import secrets
import shutil

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from .. import applog, config
from ..auth import require_role
from ..users import User
from ..importer import ImportFailed, commit, guess_table, preview, read_rows, split_header
from ..meta import TABLES

analyst = require_role("analyst")
router = APIRouter(prefix="/api/import", tags=["import"], dependencies=[Depends(analyst)])

MAX_UPLOAD_BYTES = 80 * 1024 * 1024
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def _paths(token: str):
    if not _TOKEN_RE.match(token):
        raise HTTPException(400, "无效的上传标识")
    meta = config.UPLOAD_DIR / f"{token}.json"
    if not meta.exists():
        raise HTTPException(404, "上传的文件已过期，请重新上传")
    info = json.loads(meta.read_text())
    return config.UPLOAD_DIR / info["stored"], info


@router.post("/upload")
def upload(file: UploadFile = File(...)):
    name = file.filename or "upload"
    suffix = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if suffix not in (".xlsx", ".xls", ".csv"):
        raise HTTPException(400, "只支持 .xlsx、.xls 和 .csv 文件")
    token = secrets.token_urlsafe(18)
    stored = f"{token}{suffix}"
    dest = config.UPLOAD_DIR / stored
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out, length=1024 * 1024)
    if dest.stat().st_size > MAX_UPLOAD_BYTES:
        dest.unlink()
        raise HTTPException(400, "文件超过 80MB")
    (config.UPLOAD_DIR / f"{token}.json").write_text(json.dumps({"filename": name, "stored": stored}, ensure_ascii=False))
    try:
        header, _ = split_header(read_rows(dest))
    except ImportFailed as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(400, f"文件无法读取：{e}")
    return {"token": token, "filename": name, "header": header, "suggested_table": guess_table(header, name)}


class PreviewIn(BaseModel):
    token: str
    table: str


def _check_importable(table: str):
    if table not in TABLES:
        raise HTTPException(400, "未知的表")
    if not TABLES[table].importable:
        raise HTTPException(400, f"{table} 是汇总表，导入 {TABLES[table].derived_from} 时自动生成，不能直接导入")


@router.post("/preview")
def do_preview(body: PreviewIn):
    _check_importable(body.table)
    path, info = _paths(body.token)
    try:
        return preview(body.table, path, info["filename"])
    except ImportFailed as e:
        raise HTTPException(400, str(e))


class CommitIn(PreviewIn):
    mode: str


@router.post("/commit")
def do_commit(body: CommitIn, user: User = Depends(analyst)):
    _check_importable(body.table)
    path, info = _paths(body.token)
    try:
        result = commit(body.table, path, body.mode, info["filename"])
    except ImportFailed as e:
        applog.record(body.table, info["filename"], body.mode, "rejected", message=str(e), username=user.username)
        raise HTTPException(400, str(e))
    except Exception as e:
        applog.record(body.table, info["filename"], body.mode, "failed", message=str(e), username=user.username)
        raise HTTPException(500, f"写入失败，已回滚：{e}")
    applog.record(
        body.table, info["filename"], body.mode, "ok",
        deleted=result["deleted"], inserted=result["inserted"], dates=result["dates"], username=user.username,
    )
    for p in (path, config.UPLOAD_DIR / f"{body.token}.json"):
        p.unlink(missing_ok=True)
    return result


@router.get("/history")
def history():
    return applog.history()
