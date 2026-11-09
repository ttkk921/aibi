"""AI 问数 history: every question with what the user saw of the answer, in data/app.db, for admins to read.

One row per question. The answer is kept as the events the drawer received (text merged, query results with
their rows, charts, confirmations, errors), so the history page can show it the way the user saw it. A question
paused for SQL approval stays one row: the approval's events are appended to it."""
import json
import sqlite3
from datetime import datetime

from . import config

_DB = config.DATA_DIR / "app.db"
# Events the history keeps: status lines and keep-alives are only for the live drawer.
KEPT = {"text", "tool_start", "tool_result", "confirm", "error"}


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """create table if not exists chat_log (
            id integer primary key autoincrement,
            created_at text not null,
            updated_at text not null,
            username text not null,
            conversation_id text not null,
            question text not null,
            context text,
            model text,
            status text not null,
            answer text not null default '',
            error text,
            tool_count integer not null default 0,
            seconds real not null default 0,
            prompt_tokens integer not null default 0,
            completion_tokens integer not null default 0,
            events text not null default '[]'
        )"""
    )
    conn.execute("create index if not exists chat_log_conversation on chat_log (conversation_id, id)")
    return conn


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def compact(events: list[dict]) -> list[dict]:
    """The kept events, with consecutive text deltas joined into one."""
    out: list[dict] = []
    for ev in events:
        if ev.get("type") not in KEPT:
            continue
        if ev["type"] == "text" and out and out[-1]["type"] == "text":
            out[-1] = {"type": "text", "delta": out[-1]["delta"] + ev["delta"]}
        else:
            out.append(dict(ev))
    return out


def start(username: str, conversation_id: str, question: str, context: str | None, model: str) -> int:
    now = _now()
    with _conn() as conn:
        cur = conn.execute(
            "insert into chat_log (created_at, updated_at, username, conversation_id, question, context, model, status) "
            "values (?, ?, ?, ?, ?, ?, ?, 'running')",
            (now, now, username, conversation_id, question, context, model),
        )
        return cur.lastrowid


def finish(log_id: int, events: list[dict], status: str, seconds: float, usage: dict):
    """Append one request's events (the question, or an approval of its SQL) to the row."""
    with _conn() as conn:
        row = conn.execute("select events from chat_log where id = ?", (log_id,)).fetchone()
        if row is None:
            return
        all_events = compact(json.loads(row["events"]) + events)
        answer = "".join(e["delta"] for e in all_events if e["type"] == "text")
        errors = [e["message"] for e in all_events if e["type"] == "error"]
        tools = sum(1 for e in all_events if e["type"] == "tool_result")
        conn.execute(
            "update chat_log set updated_at = ?, status = ?, answer = ?, error = ?, tool_count = ?, "
            "seconds = seconds + ?, prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?, events = ? "
            "where id = ?",
            (
                _now(), status, answer, errors[-1] if errors else None, tools,
                round(seconds, 1), usage.get("prompt", 0), usage.get("completion", 0),
                json.dumps(all_events, ensure_ascii=False, default=str), log_id,
            ),
        )


_LIST_COLS = (
    "id, created_at, username, conversation_id, question, context, model, status, substr(answer, 1, 200) as answer, "
    "error, tool_count, seconds, prompt_tokens, completion_tokens"
)


def search(username: str | None, q: str | None, date_from: str | None, date_to: str | None, limit: int, offset: int) -> dict:
    where, params = [], []
    if username:
        where.append("username = ?")
        params.append(username)
    if q:
        where.append("(question like ? or answer like ?)")
        params += [f"%{q}%", f"%{q}%"]
    if date_from:
        where.append("created_at >= ?")
        params.append(date_from)
    if date_to:
        where.append("created_at < date(?, '+1 day')")
        params.append(date_to)
    sql_where = f" where {' and '.join(where)}" if where else ""
    with _conn() as conn:
        total = conn.execute(f"select count(*) from chat_log{sql_where}", params).fetchone()[0]
        rows = conn.execute(
            f"select {_LIST_COLS} from chat_log{sql_where} order by id desc limit ? offset ?", [*params, limit, offset]
        ).fetchall()
        users = [r[0] for r in conn.execute("select distinct username from chat_log order by username")]
    return {"total": total, "items": [dict(r) for r in rows], "users": users}


def conversation(log_id: int) -> list[dict] | None:
    """Every question of the conversation `log_id` belongs to, oldest first, with their events."""
    with _conn() as conn:
        row = conn.execute("select conversation_id from chat_log where id = ?", (log_id,)).fetchone()
        if row is None:
            return None
        rows = conn.execute(
            "select * from chat_log where conversation_id = ? order by id", (row["conversation_id"],)
        ).fetchall()
    return [{**dict(r), "events": json.loads(r["events"])} for r in rows]
