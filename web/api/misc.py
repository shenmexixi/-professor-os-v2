# web/api/misc.py
from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/work_items")
async def get_work_items(request: Request):
    repo = request.app.state.repo
    return {"work_items": repo.list_work_items()}


@router.get("/people")
async def get_people(request: Request):
    repo = request.app.state.repo
    return {"people": repo.list_people_with_task_count()}
