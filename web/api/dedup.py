# web/api/dedup.py
import json
from fastapi import APIRouter, Request

router = APIRouter()

_DEDUP_SYSTEM = """你是任务去重助手。给定任务列表（JSON数组），找出语义相同或高度相似的任务对。
只返回 JSON，格式：{"pairs": [{"id_a": int, "id_b": int, "reason": str}]}
没有重复则返回 {"pairs": []}。不要输出任何其他文字。"""


@router.post("/tasks/similar")
async def find_similar_tasks(request: Request):
    repo = request.app.state.repo
    provider = request.app.state.provider

    tasks = repo.list_tasks()
    wi_map = {wi["id"]: wi["title"] for wi in repo.list_work_items()}
    task_list = [
        {"id": t["id"], "title": t["title"],
         "work_item_title": wi_map.get(t["work_item_id"], "")}
        for t in tasks
    ]

    if not provider or len(task_list) < 2:
        return {"pairs": []}

    user_msg = json.dumps(task_list, ensure_ascii=False)
    try:
        result = provider.parse_raw(system=_DEDUP_SYSTEM, user=user_msg)
        pairs = result.get("pairs", [])
    except Exception:
        pairs = []

    valid_ids = {t["id"] for t in task_list}
    id_to_task = {t["id"]: t for t in task_list}
    clean_pairs = []
    for p in pairs:
        if p.get("id_a") in valid_ids and p.get("id_b") in valid_ids:
            clean_pairs.append({
                "task_a": id_to_task[p["id_a"]],
                "task_b": id_to_task[p["id_b"]],
                "reason": p.get("reason", ""),
            })

    return {"pairs": clean_pairs}
