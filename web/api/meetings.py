# web/api/meetings.py
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()

VALID_STATUS = {"planned", "in_progress", "done"}
VALID_MEMBER_ROLES = {"organizer", "participant", "reporter"}


class MeetingBody(BaseModel):
    title: str = "新会议"
    scheduled_at: str | None = None


class MeetingPatch(BaseModel):
    title: str | None = None
    status: str | None = None
    scheduled_at: str | None = None


class MemberBody(BaseModel):
    person_name: str
    role: str
    person_id: int | None = None


class MeetingTaskBody(BaseModel):
    task_id: int
    wi_title: str = ""


class NotesBody(BaseModel):
    content: str


@router.post("/meetings")
async def create_meeting(body: MeetingBody, request: Request):
    repo = request.app.state.repo
    mid = repo.create_meeting(title=body.title, scheduled_at=body.scheduled_at)
    return {"ok": True, "id": mid}


@router.get("/meetings")
async def list_meetings(request: Request):
    repo = request.app.state.repo
    return {"meetings": repo.list_meetings()}


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: int, request: Request):
    repo = request.app.state.repo
    m = repo.get_meeting_full(meeting_id)
    if not m:
        raise HTTPException(status_code=404, detail="meeting not found")
    return m


@router.patch("/meetings/{meeting_id}")
async def patch_meeting(meeting_id: int, body: MeetingPatch, request: Request):
    repo = request.app.state.repo
    if not repo.get_meeting(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    kwargs = {k: v for k, v in body.model_dump().items() if v is not None}
    if "status" in kwargs and kwargs["status"] not in VALID_STATUS:
        raise HTTPException(status_code=422, detail=f"Invalid status: {kwargs['status']}")
    if kwargs:
        repo.update_meeting(meeting_id, **kwargs)
    return {"ok": True}


@router.delete("/meetings/{meeting_id}")
async def delete_meeting(meeting_id: int, request: Request):
    repo = request.app.state.repo
    if not repo.get_meeting(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    repo.delete_meeting(meeting_id)
    return {"ok": True}


@router.post("/meetings/{meeting_id}/members")
async def add_member(meeting_id: int, body: MemberBody, request: Request):
    repo = request.app.state.repo
    if not repo.get_meeting(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    if body.role not in VALID_MEMBER_ROLES:
        raise HTTPException(status_code=422, detail=f"Invalid role: {body.role}")
    repo.add_meeting_member(meeting_id, person_name=body.person_name,
                            role=body.role, person_id=body.person_id)
    return {"ok": True}


@router.delete("/meetings/{meeting_id}/members/{person_name}")
async def remove_member(meeting_id: int, person_name: str, request: Request):
    repo = request.app.state.repo
    repo.remove_meeting_member(meeting_id, person_name=person_name)
    return {"ok": True}


@router.post("/meetings/{meeting_id}/tasks")
async def add_task(meeting_id: int, body: MeetingTaskBody, request: Request):
    repo = request.app.state.repo
    if not repo.get_meeting(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    repo.add_meeting_task(meeting_id, task_id=body.task_id, wi_title=body.wi_title)
    return {"ok": True}


@router.delete("/meetings/{meeting_id}/tasks/{task_id}")
async def remove_task(meeting_id: int, task_id: int, request: Request):
    repo = request.app.state.repo
    repo.remove_meeting_task(meeting_id, task_id=task_id)
    return {"ok": True}


@router.put("/meetings/{meeting_id}/notes")
async def upsert_notes(meeting_id: int, body: NotesBody, request: Request):
    repo = request.app.state.repo
    if not repo.get_meeting(meeting_id):
        raise HTTPException(status_code=404, detail="meeting not found")
    repo.upsert_meeting_notes(meeting_id, content=body.content)
    return {"ok": True}
