# web/api/schedule_plan.py
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()


class ScheduleEntryBody(BaseModel):
    task_id: int
    is_current: int = 1
    date_start: str | None = None
    date_end: str | None = None


class NodeScheduleEntryBody(BaseModel):
    node_id: int
    is_current: int = 1
    date_start: str | None = None
    date_end: str | None = None


@router.get("/schedule_entries")
async def get_schedule_entries(request: Request):
    repo = request.app.state.repo
    entries = repo.list_schedule_entries()
    node_entries = repo.list_node_entries()
    return {
        "entries": {str(k): v for k, v in entries.items()},
        "node_entries": {str(k): v for k, v in node_entries.items()},
    }


@router.post("/schedule_entries")
async def upsert_schedule_entry(body: ScheduleEntryBody, request: Request):
    repo = request.app.state.repo
    repo.add_or_update_schedule_entry(
        body.task_id, body.is_current, body.date_start, body.date_end
    )
    return {"ok": True}


@router.delete("/schedule_entries/{task_id}")
async def delete_schedule_entry(task_id: int, request: Request):
    repo = request.app.state.repo
    deleted = repo.delete_schedule_entry(task_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"ok": True}


@router.post("/node_schedule_entries")
async def upsert_node_entry(body: NodeScheduleEntryBody, request: Request):
    repo = request.app.state.repo
    repo.add_or_update_node_entry(
        body.node_id, body.is_current, body.date_start, body.date_end
    )
    return {"ok": True}


@router.delete("/node_schedule_entries/{node_id}")
async def delete_node_entry(node_id: int, request: Request):
    repo = request.app.state.repo
    deleted = repo.delete_node_entry(node_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"ok": True}
