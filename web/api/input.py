# web/api/input.py
import json
from fastapi import APIRouter, Request
from pydantic import BaseModel

from parser.parser import parse_input

router = APIRouter()


class InputRequest(BaseModel):
    text: str
    is_onboarding: bool = False


@router.post("/input")
async def post_input(body: InputRequest, request: Request):
    repo = request.app.state.repo
    provider = request.app.state.provider

    input_id = repo.save_input(raw_text=body.text)

    db_context = repo.get_db_context()
    try:
        result = parse_input(body.text, db_context=db_context, provider=provider, onboarding=body.is_onboarding)
    except Exception as e:
        return {"error": str(e), "input_id": input_id, "changes": [], "pending_questions": []}

    parsed = [{"action": c.action, "data": c.data, "confirmed": c.confirmed} for c in result.changes]
    request.app.state.conn.execute(
        "UPDATE daily_inputs SET parsed_json=? WHERE id=?",
        (json.dumps(parsed), input_id)
    )
    request.app.state.conn.commit()

    return {
        "input_id": input_id,
        "changes": parsed,
        "pending_questions": result.pending_questions,
    }
