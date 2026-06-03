"""
POST /api/tray/pref  — apply theme or font size from tray (broadcasts via SSE).
GET  /api/tray/pref  — returns current pending pref (polled by old clients as fallback).
"""
from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter()


class PrefUpdate(BaseModel):
    theme: str | None = None
    font_size: str | None = None


@router.post("/tray/pref")
async def set_tray_pref(body: PrefUpdate, request: Request):
    payload = {}
    if body.theme:
        payload['theme'] = body.theme
    if body.font_size:
        payload['font_size'] = body.font_size
    if not payload:
        return {"ok": False}

    import json
    msg = "pref:" + json.dumps(payload)
    for queue in list(request.app.state.sse_subscribers):
        try:
            queue.put_nowait(msg)
        except Exception:
            pass
    return {"ok": True}
