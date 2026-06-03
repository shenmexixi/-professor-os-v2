# web/api/confirm.py
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

import config
from db.snapshot import create_snapshot, restore_snapshot
from db.applier import apply_changes
from parser.llm.base import ParsedChange

router = APIRouter()


class ConfirmRequest(BaseModel):
    input_id: int
    changes: list[dict[str, Any]]


@router.post("/confirm")
async def post_confirm(body: ConfirmRequest, request: Request):
    repo = request.app.state.repo
    conn = request.app.state.conn
    snapshots_dir = str(config.SNAPSHOTS_DIR)
    Path(snapshots_dir).mkdir(parents=True, exist_ok=True)

    try:
        create_snapshot(conn, input_id=body.input_id, snapshots_dir=snapshots_dir)
        changes = [ParsedChange(**{k: v for k, v in c.items() if k in ("action", "data", "confirmed")}) for c in body.changes]
        summaries = apply_changes(repo, changes)
        repo.confirm_input(body.input_id)
    except Exception as e:
        return {"error": str(e), "summaries": []}

    for queue in list(request.app.state.sse_subscribers):
        try:
            queue.put_nowait("schedule_updated")
        except Exception:
            pass

    return {"summaries": summaries}


@router.post("/undo")
async def post_undo(request: Request):
    conn = request.app.state.conn
    snapshots_dir = str(config.SNAPSHOTS_DIR)
    snaps = sorted(Path(snapshots_dir).glob("snapshot_*.json"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    if not snaps:
        return {"error": "无可用快照"}
    try:
        restore_snapshot(conn, snaps[0])
    except Exception as e:
        return {"error": str(e)}
    return {"restored": snaps[0].name}
