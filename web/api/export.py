"""
GET /api/export/csv  — full database backup as a ZIP of CSV files.

Sheets included:
  - work_items.csv
  - tasks.csv         (with work_item_title and assignees columns)
  - people.csv
  - workflow_nodes.csv
  - meetings.csv
"""
import csv
import io
import zipfile
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter()


@router.get("/export/csv")
async def export_csv(request: Request):
    repo = request.app.state.repo
    conn = request.app.state.conn

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:

        # ── work_items ───────────────────────────────────────────────────────
        wis = repo.list_work_items()
        zf.writestr('work_items.csv', _to_csv(wis, [
            'id', 'title', 'type', 'importance', 'urgency', 'deadline', 'status',
        ]))

        # ── people ───────────────────────────────────────────────────────────
        people = repo.list_people()
        zf.writestr('people.csv', _to_csv(people, [
            'id', 'name', 'role', 'expertise', 'bandwidth',
        ]))

        # ── tasks (with work_item_title and assignees) ───────────────────────
        wi_map = {w['id']: w['title'] for w in wis}
        tasks = repo.list_tasks()

        # Fetch assignments for all tasks in one query
        rows = conn.execute(
            """SELECT ta.task_id, p.name, ta.role_in_task
               FROM task_assignments ta
               LEFT JOIN people p ON ta.person_id = p.id"""
        ).fetchall()
        asgn_map: dict[int, list[str]] = {}
        for task_id, name, role in rows:
            asgn_map.setdefault(task_id, []).append(f"{name}({role})")

        task_rows = []
        for t in tasks:
            task_rows.append({
                'id': t['id'],
                'title': t['title'],
                'work_item': wi_map.get(t.get('work_item_id'), ''),
                'ownership': t['ownership'],
                'status': t['status'],
                'due_date': t.get('due_date', ''),
                'assignees': '; '.join(asgn_map.get(t['id'], [])),
            })
        zf.writestr('tasks.csv', _to_csv(task_rows, [
            'id', 'title', 'work_item', 'ownership', 'status', 'due_date', 'assignees',
        ]))

        # ── workflow_nodes ───────────────────────────────────────────────────
        node_rows = conn.execute(
            """SELECT wn.id, wn.title, wn.status, wn.time_estimate,
                      t.title as task_title, w.title as work_item_title
               FROM workflow_nodes wn
               JOIN tasks t ON wn.task_id = t.id
               LEFT JOIN work_items w ON t.work_item_id = w.id
               WHERE wn.is_deleted = 0 AND t.is_deleted = 0"""
        ).fetchall()
        zf.writestr('workflow_nodes.csv', _to_csv(
            [dict(r) for r in node_rows],
            ['id', 'title', 'status', 'time_estimate', 'task_title', 'work_item_title'],
        ))

        # ── meetings ─────────────────────────────────────────────────────────
        meetings = repo.list_meetings()
        for m in meetings:
            members = repo.list_meeting_members(m['id'])
            m['members'] = '; '.join(
                f"{mb['person_name']}({mb['role']})" for mb in members
            )
        zf.writestr('meetings.csv', _to_csv(meetings, [
            'id', 'title', 'status', 'scheduled_at', 'created_at', 'members',
        ]))

    buf.seek(0)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f'professor_os_backup_{ts}.zip'

    return StreamingResponse(
        buf,
        media_type='application/zip',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'},
    )


def _to_csv(rows: list[dict], fields: list[str]) -> str:
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=fields, extrasaction='ignore',
                       lineterminator='\r\n')
    w.writeheader()
    w.writerows(rows)
    # UTF-8 BOM so Excel opens Chinese correctly
    return '\ufeff' + out.getvalue()
