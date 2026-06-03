# web/api/work_item.py
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()


class WorkItemCreate(BaseModel):
    title: str
    type: str = "project"
    importance: int = 3
    urgency: int = 3


class WorkItemPatch(BaseModel):
    title: str | None = None
    importance: int | None = None
    urgency: int | None = None
    sort_order: int | None = None


@router.post("/work_item")
async def create_work_item(body: WorkItemCreate, request: Request):
    repo = request.app.state.repo
    new_id = repo.add_work_item(
        title=body.title,
        type=body.type,
        importance=body.importance,
        urgency=body.urgency,
    )
    return {"id": new_id}


@router.patch("/work_item/{work_item_id}")
async def patch_work_item(work_item_id: int, body: WorkItemPatch, request: Request):
    repo = request.app.state.repo
    item = repo.get_work_item(work_item_id)
    if not item or item["is_deleted"]:
        raise HTTPException(status_code=404, detail="work_item not found")
    kwargs = {k: v for k, v in body.model_dump().items() if v is not None}
    if kwargs:
        repo.update_work_item(work_item_id, **kwargs)
    return {"ok": True}


@router.delete("/work_item/{work_item_id}")
async def delete_work_item(work_item_id: int, request: Request):
    repo = request.app.state.repo
    item = repo.get_work_item(work_item_id)
    if not item or item["is_deleted"]:
        raise HTTPException(status_code=404, detail="work_item not found")
    repo.delete_work_item(work_item_id)
    return {"ok": True}
