# web/api/schedule.py
from fastapi import APIRouter, Request

from scheduler.engine import get_ranked_work_items, get_tasks_for_item

router = APIRouter()


@router.get("/schedule")
async def get_schedule(request: Request):
    repo = request.app.state.repo
    items = get_ranked_work_items(repo)

    result = []
    for item in items:
        tasks = get_tasks_for_item(repo, item["id"])
        participant_ids = set()
        for t in tasks:
            for a in t.get("assignments", []):
                if a["person_id"] is not None:
                    participant_ids.add(a["person_id"])

        # Fetch workflow nodes once per task; compute progress and include in response
        done, total = 0, 0
        task_nodes = {}
        for t in tasks:
            nodes = repo.list_workflow_nodes(t["id"])
            task_nodes[t["id"]] = nodes
            top_nodes = [n for n in nodes if n["parent_node_id"] is None]
            total += len(top_nodes)
            done += sum(1 for n in top_nodes if n["status"] == "done")

        result.append({
            **item,
            "score": round(item["importance"] * item["urgency"], 1),
            "task_count": len(tasks),
            "participant_count": len(participant_ids),
            "workflow_progress": {"done": done, "total": total},
            "tasks": [
                {
                    **t,
                    "score": round(item["importance"] * item["urgency"], 1),
                    "workflow_nodes": task_nodes[t["id"]],
                }
                for t in tasks
            ],
        })

    return {"work_items": result}
