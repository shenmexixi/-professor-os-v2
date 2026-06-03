# web/api/task.py
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()


class TaskCreate(BaseModel):
    title: str
    work_item_id: int | None = None
    ownership: str = "self_lead"


class TaskPatch(BaseModel):
    title: str | None = None
    priority: int | None = None
    parent_task_id: int | None = None
    follows_task_id: int | None = None
    status: str | None = None


@router.post("/task")
async def create_task(body: TaskCreate, request: Request):
    repo = request.app.state.repo
    new_id = repo.add_task(
        title=body.title,
        work_item_id=body.work_item_id,
        ownership=body.ownership,
    )
    return {"id": new_id}


@router.patch("/task/{task_id}")
async def patch_task(task_id: int, body: TaskPatch, request: Request):
    repo = request.app.state.repo
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")
    kwargs = {k: v for k, v in body.model_dump().items() if v is not None}
    if kwargs:
        repo.update_task(task_id, **kwargs)
    return {"ok": True}


@router.delete("/task/{task_id}")
async def delete_task(task_id: int, request: Request):
    repo = request.app.state.repo
    task = repo.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")
    repo.delete_task(task_id)
    return {"ok": True}
