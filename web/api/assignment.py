# web/api/assignment.py
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()


class AddAssignmentRequest(BaseModel):
    person_name: str
    role: str


class RemoveAssignmentRequest(BaseModel):
    person_id: int
    role: str


@router.post("/task/{task_id}/assignment")
async def add_assignment(task_id: int, body: AddAssignmentRequest, request: Request):
    repo = request.app.state.repo
    if repo.get_task(task_id) is None:
        raise HTTPException(status_code=404, detail="task not found")
    person = repo.get_person_by_name(body.person_name)
    if person is None:
        person_id = repo.add_person(body.person_name, role="master")
    else:
        person_id = person["id"]
    repo.add_assignment(task_id, person_id, body.role)
    return {"ok": True, "person_id": person_id}


@router.delete("/task/{task_id}/assignment")
async def remove_assignment(task_id: int, body: RemoveAssignmentRequest, request: Request):
    repo = request.app.state.repo
    if repo.get_task(task_id) is None:
        raise HTTPException(status_code=404, detail="task not found")
    removed = repo.remove_assignment(task_id, body.person_id, body.role)
    if not removed:
        raise HTTPException(status_code=404, detail="assignment not found")
    return {"ok": True}
