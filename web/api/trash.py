# web/api/trash.py
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()


@router.get("/trash")
async def get_trash(request: Request):
    repo = request.app.state.repo
    return repo.get_trash()


class RestoreRequest(BaseModel):
    table: str
    id: int


@router.post("/restore")
async def restore_item(body: RestoreRequest, request: Request):
    repo = request.app.state.repo
    try:
        updated = repo.restore_item(body.table, body.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not updated:
        raise HTTPException(status_code=404, detail="item not found or not deleted")
    return {"ok": True}
