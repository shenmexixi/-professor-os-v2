# professor-os/scheduler/engine.py
from db.repository import Repository


def get_ranked_work_items(repo: Repository) -> list[dict]:
    """
    Return active work_items sorted by priority.
    Score = importance * urgency (higher = more urgent/important).
    Soft-deleted items are excluded.
    """
    items = repo.list_work_items(include_deleted=False)

    def _score(item: dict) -> float:
        return item["importance"] * item["urgency"]

    return sorted(items, key=lambda item: (-_score(item), item["id"]))


def get_tasks_for_item(repo: Repository, work_item_id: int) -> list[dict]:
    """
    Return all active tasks for a work_item, each with their assignments embedded.
    Tasks are sorted by priority (ascending, lower value = higher priority).
    """
    tasks = repo.list_tasks(work_item_id=work_item_id, include_deleted=False)
    tasks.sort(key=lambda t: (t.get("priority", 0), t.get("due_date") or ""))
    for task in tasks:
        task["assignments"] = repo.get_assignments(task["id"])
    return tasks
