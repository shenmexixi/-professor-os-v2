"""
Export all data associated with a named person to a portable JSON file.

Usage:
    python tools/export_person.py "张三" [--output export_zhangsan.json]
    python tools/export_person.py "张三" --db path/to/custom.db

Excludes: daily_inputs, meetings/meeting_notes, schedule_entries (instance-specific state).
Strips all numeric IDs — import uses titles for deduplication and resolution.
"""
import sys
import json
import argparse
from datetime import datetime
from pathlib import Path

# Allow running from repo root or tools/ directory
sys.path.insert(0, str(Path(__file__).parent.parent))

import sqlite3
from db.repository import Repository
from config import config


def export_person(person_name: str, output_file: str, db_path: str | None = None) -> None:
    path = db_path or str(config.db_path)
    conn = sqlite3.connect(path)
    repo = Repository(conn)

    # --- Resolve person ---
    person = repo.get_person_by_name(person_name)
    if not person:
        print(f"Error: person not found: {person_name!r}")
        sys.exit(1)

    person_id = person['id']

    # --- Find all task_ids where this person is assigned ---
    rows = conn.execute(
        """SELECT DISTINCT ta.task_id
           FROM task_assignments ta
           JOIN tasks t ON t.id = ta.task_id
           WHERE ta.person_id = ? AND t.is_deleted = 0""",
        (person_id,)
    ).fetchall()
    task_ids = [r[0] for r in rows]

    if not task_ids:
        print(f"Warning: {person_name!r} has no associated tasks. Export will be empty.")

    # --- Collect tasks ---
    tasks_out = []
    work_item_ids_seen: set[int] = set()

    for task_id in task_ids:
        task = repo.get_task(task_id)
        if not task:
            continue

        assignments = repo.get_assignments(task_id)
        nodes = repo.list_workflow_nodes(task_id)

        # Build parent_node_title lookup for portability
        node_title_map: dict[int, str] = {n['id']: n['title'] for n in nodes}

        tasks_out.append({
            "title": task['title'],
            "work_item_title": _wi_title(conn, task.get('work_item_id')),
            "ownership": task.get('ownership'),
            "due_date": task.get('due_date'),
            "status": task.get('status'),
            "assignments": [
                {
                    "person_name": a['person_name'],
                    "role_in_task": a['role_in_task'],
                }
                for a in assignments
            ],
            "workflow_nodes": [
                {
                    "title": n['title'],
                    "status": n.get('status'),
                    "time_estimate": n.get('time_estimate'),
                    "parent_node_title": node_title_map.get(n['parent_node_id'])
                                         if n.get('parent_node_id') else None,
                }
                for n in nodes
            ],
        })

        if task.get('work_item_id'):
            work_item_ids_seen.add(task['work_item_id'])

    # --- Collect work items ---
    work_items_out = []
    for wi_id in work_item_ids_seen:
        wi = repo.get_work_item(wi_id)
        if wi:
            work_items_out.append({
                "title": wi['title'],
                "type": wi.get('type'),
                "importance": wi.get('importance'),
                "urgency": wi.get('urgency'),
                "deadline": wi.get('deadline'),
            })

    conn.close()

    export_data = {
        "export_version": "1",
        "exported_at": datetime.now().isoformat(timespec='seconds'),
        "source_person": {
            "name": person['name'],
            "role": person.get('role'),
            "expertise": person.get('expertise'),
            "bandwidth": person.get('bandwidth', 100),
        },
        "work_items": work_items_out,
        "tasks": tasks_out,
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(export_data, f, ensure_ascii=False, indent=2)

    total_nodes = sum(len(t['workflow_nodes']) for t in tasks_out)
    print(f"Exported: {output_file}  (person={person_name}, work_items={len(work_items_out)}, tasks={len(tasks_out)}, nodes={total_nodes})")


def _wi_title(conn: sqlite3.Connection, wi_id: int | None) -> str | None:
    if wi_id is None:
        return None
    row = conn.execute("SELECT title FROM work_items WHERE id=?", (wi_id,)).fetchone()
    return row[0] if row else None


def main():
    parser = argparse.ArgumentParser(description='导出人员任务数据为 JSON')
    parser.add_argument('person_name', help='人员姓名')
    parser.add_argument('--output', '-o', default=None,
                        help='输出文件路径（默认：export_<姓名>.json）')
    parser.add_argument('--db', default=None, help='数据库路径（默认使用配置路径）')
    args = parser.parse_args()

    output = args.output or f"export_{args.person_name}.json"
    export_person(args.person_name, output, args.db)


if __name__ == '__main__':
    main()
