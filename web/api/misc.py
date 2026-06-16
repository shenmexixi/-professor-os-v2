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


@router.get("/provider_status")
async def provider_status(request: Request):
    """Diagnostic endpoint: report whether LLM provider initialized and any error."""
    provider = request.app.state.provider
    return {
        "ok": provider is not None,
        "provider_class": type(provider).__name__ if provider else None,
        "error": getattr(request.app.state, "provider_error", None),
    }
