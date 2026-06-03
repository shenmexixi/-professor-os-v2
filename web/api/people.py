# web/api/people.py
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()

VALID_ROLES = {
    "undergraduate", "master", "phd",
    "collaborator_teacher", "clinician", "peer", "other"
}


class PersonBody(BaseModel):
    name: str
    role: str
    expertise: str = ""
    bandwidth: int = 100


class PersonPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    expertise: str | None = None
    bandwidth: int | None = None


@router.post("/people")
async def create_person(body: PersonBody, request: Request):
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Invalid role: {body.role}")
    repo = request.app.state.repo
    pid = repo.add_person(body.name, body.role, body.expertise, body.bandwidth)
    return {"ok": True, "id": pid}


@router.patch("/people/{person_id}")
async def patch_person(person_id: int, body: PersonPatch, request: Request):
    repo = request.app.state.repo
    kwargs = {k: v for k, v in body.model_dump().items() if v is not None}
    if "role" in kwargs and kwargs["role"] not in VALID_ROLES:
        raise HTTPException(status_code=422, detail=f"Invalid role: {kwargs['role']}")
    if kwargs:
        repo.update_person(person_id, **kwargs)
    return {"ok": True}


@router.delete("/people/{person_id}")
async def delete_person(person_id: int, request: Request):
    repo = request.app.state.repo
    repo.delete_person(person_id)
    return {"ok": True}
