"""
Import a person-export JSON file into the current database instance.

Usage:
    python tools/import_data.py export_zhangsan.json
    python tools/import_data.py export_zhangsan.json --db path/to/custom.db

Import sequence:
  1. Validate JSON schema version
  2. work_items: skip if title already exists, insert otherwise
  3. source_person: look up by name, create if not found
  4. tasks: skip if same title under same work_item already exists
  5. task_assignments: look up/create each person by name, then insert assignment
  6. workflow_nodes: insert in order, resolving parent_node_title → parent_node_id
"""
import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import sqlite3
from db.repository import Repository
from config import config


SUPPORTED_VERSION = "1"


def import_data(input_file: str, db_path: str | None = None) -> None:
    path = db_path or str(config.db_path)
    conn = sqlite3.connect(path)
    repo = Repository(conn)

    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # --- Validate version ---
    version = str(data.get("export_version", ""))
    if version != SUPPORTED_VERSION:
        print(f"Error: unsupported export version {version!r} (supported: {SUPPORTED_VERSION})")
        sys.exit(1)

    print(f"Importing: {input_file}")
    print(f"Exported at: {data.get('exported_at', 'unknown')}")

    # --- Counters ---
    wi_inserted = wi_skipped = 0
    task_inserted = task_skipped = 0
    node_inserted = 0

    # --- 1. Import work items ---
    wi_title_to_id: dict[str, int] = {}
    for wi in data.get("work_items", []):
        title = wi["title"]
        existing = repo.get_work_item_by_title(title)
        if existing:
            wi_title_to_id[title] = existing["id"]
            wi_skipped += 1
        else:
            new_id = repo.add_work_item(
                title=title,
                type=wi.get("type", "project"),
                importance=wi.get("importance", 3),
                urgency=wi.get("urgency", 3),
                deadline=wi.get("deadline"),
            )
            wi_title_to_id[title] = new_id
            wi_inserted += 1

    print(f"[OK] Work items: +{wi_inserted} new, {wi_skipped} skipped")

    # --- 2. Ensure source person exists ---
    src = data.get("source_person", {})
    src_name = src.get("name", "")
    _ensure_person(repo, src_name, src)

    # --- 3. Import tasks ---
    task_title_wi_to_id: dict[tuple[str, int | None], int] = {}

    for task in data.get("tasks", []):
        wi_title = task.get("work_item_title")
        wi_id = wi_title_to_id.get(wi_title) if wi_title else None

        task_title = task["title"]
        existing_id = _find_task(conn, task_title, wi_id)

        if existing_id:
            task_title_wi_to_id[(task_title, wi_id)] = existing_id
            task_skipped += 1
            continue

        new_task_id = repo.add_task(
            title=task_title,
            work_item_id=wi_id,
            ownership=task.get("ownership", "self_lead"),
            due_date=task.get("due_date"),
            status=task.get("status", "todo"),
        )
        task_title_wi_to_id[(task_title, wi_id)] = new_task_id
        task_inserted += 1

        # --- 4. Task assignments ---
        for asgn in task.get("assignments", []):
            person_name = asgn.get("person_name", "")
            if not person_name:
                continue
            person = repo.get_person_by_name(person_name)
            if not person:
                person_id = repo.add_person(name=person_name, role="")
            else:
                person_id = person["id"]
            repo.add_assignment(new_task_id, person_id, asgn.get("role_in_task", "executor"))

        # --- 5. Workflow nodes ---
        nodes = task.get("workflow_nodes", [])
        node_title_to_id: dict[str, int] = {}
        for node in nodes:
            parent_title = node.get("parent_node_title")
            parent_id = node_title_to_id.get(parent_title) if parent_title else None
            new_node_id = repo.add_workflow_node(
                task_id=new_task_id,
                title=node["title"],
                parent_node_id=parent_id,
                time_estimate=node.get("time_estimate"),
            )
            node_title_to_id[node["title"]] = new_node_id
            node_inserted += 1

    print(f"[OK] Tasks:      +{task_inserted} new, {task_skipped} skipped")
    if node_inserted:
        print(f"[OK] Nodes:      +{node_inserted}")

    conn.close()
    print("Import complete.")


def _find_task(conn: sqlite3.Connection, title: str, wi_id: int | None) -> int | None:
    """Return existing task id by title+work_item_id if found, else None."""
    if wi_id is not None:
        row = conn.execute(
            "SELECT id FROM tasks WHERE title=? AND work_item_id=? AND is_deleted=0",
            (title, wi_id)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT id FROM tasks WHERE title=? AND work_item_id IS NULL AND is_deleted=0",
            (title,)
        ).fetchone()
    return row[0] if row else None


def _ensure_person(repo: Repository, name: str, src: dict) -> int:
    """Return person id, creating if not found."""
    if not name:
        return None
    person = repo.get_person_by_name(name)
    if person:
        return person["id"]
    return repo.add_person(
        name=name,
        role=src.get("role", ""),
        expertise=src.get("expertise", "") or "",
        bandwidth=src.get("bandwidth", 100) or 100,
    )


def main():
    parser = argparse.ArgumentParser(description='导入任务数据 JSON')
    parser.add_argument('input_file', help='导入文件路径')
    parser.add_argument('--db', default=None, help='数据库路径（默认使用配置路径）')
    args = parser.parse_args()
    import_data(args.input_file, args.db)


if __name__ == '__main__':
    main()
