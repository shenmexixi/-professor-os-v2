# professor-os/db/applier.py
from db.repository import Repository
from parser.llm.base import ParsedChange


def apply_changes(repo: Repository, changes: list[ParsedChange]) -> list[str]:
    """
    Apply a list of confirmed ParsedChanges to the DB.
    Unconfirmed changes are skipped.
    Returns a list of human-readable summary strings for display.
    """
    summaries = []
    for change in changes:
        if not change.confirmed:
            continue
        summary = _apply_one(repo, change)
        if summary:
            summaries.append(summary)
    return summaries


def _apply_one(repo: Repository, change: ParsedChange) -> str:
    action = change.action
    data = change.data

    if action == "add_task":
        executor_name = data.get("executor_name")
        stakeholder_names = data.get("stakeholder_names", [])

        # Resolve work_item_id: prefer explicit id, fall back to title lookup
        work_item_id = data.get("work_item_id")
        if not work_item_id and data.get("work_item_title"):
            wi = repo.get_work_item_by_title(data["work_item_title"])
            if wi:
                work_item_id = wi["id"]

        task_id = repo.add_task(
            title=data["title"],
            work_item_id=work_item_id,
            ownership=data.get("ownership", "self_lead"),
            due_date=data.get("due_date"),
        )
        # owner = self (person_id=None)
        repo.add_assignment(task_id=task_id, person_id=None, role_in_task="owner")

        if executor_name:
            person = repo.get_person_by_name(executor_name)
            if not person:
                pid = repo.add_person(name=executor_name, role="other")
            else:
                pid = person["id"]
            repo.add_assignment(task_id=task_id, person_id=pid, role_in_task="executor")

        for name in stakeholder_names:
            person = repo.get_person_by_name(name)
            if not person:
                pid = repo.add_person(name=name, role="other")
            else:
                pid = person["id"]
            repo.add_assignment(task_id=task_id, person_id=pid, role_in_task="stakeholder")

        return f"[新增任务] {data['title']}"

    elif action == "update_task":
        kwargs = {k: v for k, v in data.items() if k != "task_id" and v is not None}
        repo.update_task(data["task_id"], **kwargs)
        return f"[更新任务] id={data['task_id']}"

    elif action == "add_work_item":
        repo.add_work_item(
            title=data["title"],
            type=data["type"],
            importance=data.get("importance", 3),
            urgency=data.get("urgency", 3),
            deadline=data.get("deadline"),
            parent_id=data.get("parent_id"),
        )
        return f"[新增支线] {data['title']}"

    elif action == "update_work_item":
        kwargs = {k: v for k, v in data.items() if k != "work_item_id" and v is not None}
        repo.update_work_item(data["work_item_id"], **kwargs)
        return f"[更新支线] id={data['work_item_id']}"

    elif action == "add_stakeholder_note":
        person = repo.get_person_by_name(data["person_name"])
        if not person:
            repo.add_person(name=data["person_name"], role="other")
        return f"[合作者待办] {data['person_name']}: {data['note']}"

    return ""
