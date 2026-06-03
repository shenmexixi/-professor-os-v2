# professor-os/db/repository.py
import sqlite3


class Repository:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn
        self._conn.row_factory = sqlite3.Row

    # ── People ──────────────────────────────────────────────────────────────

    def add_person(self, name: str, role: str, expertise: str = "", bandwidth: int = 100) -> int:
        cur = self._conn.execute(
            "INSERT INTO people (name, role, expertise, bandwidth) VALUES (?,?,?,?)",
            (name, role, expertise, bandwidth)
        )
        self._conn.commit()
        return cur.lastrowid

    def get_person_by_name(self, name: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM people WHERE name=? AND is_deleted=0", (name,)
        ).fetchone()
        return dict(row) if row else None

    def list_people(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM people WHERE is_deleted=0 ORDER BY name"
        ).fetchall()
        return [dict(r) for r in rows]

    def update_person(self, person_id: int, **kwargs) -> None:
        allowed = {"name", "role", "expertise", "bandwidth"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        self._conn.execute(
            f"UPDATE people SET {sets} WHERE id=?",
            (*fields.values(), person_id)
        )
        self._conn.commit()

    def delete_person(self, person_id: int) -> None:
        self._conn.execute("UPDATE people SET is_deleted=1 WHERE id=?", (person_id,))
        self._conn.commit()

    def list_people_with_task_count(self) -> list[dict]:
        rows = self._conn.execute(
            """SELECT p.*,
                      COUNT(DISTINCT ta.task_id) as task_count,
                      COUNT(DISTINCT CASE WHEN se.is_current=1 THEN ta.task_id END) as scheduled_count
               FROM people p
               LEFT JOIN task_assignments ta ON ta.person_id = p.id
               LEFT JOIN tasks t ON t.id = ta.task_id AND t.is_deleted = 0
                                                       AND t.status NOT IN ('done','archived')
               LEFT JOIN schedule_entries se ON se.task_id = ta.task_id
               WHERE p.is_deleted = 0
               GROUP BY p.id
               ORDER BY p.name"""
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Meetings ─────────────────────────────────────────────────────────────

    def create_meeting(self, title: str = '新会议', scheduled_at: str | None = None) -> int:
        cur = self._conn.execute(
            "INSERT INTO meetings (title, scheduled_at) VALUES (?, ?)",
            (title, scheduled_at)
        )
        self._conn.commit()
        return cur.lastrowid

    def get_meeting(self, meeting_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM meetings WHERE id=?", (meeting_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_meetings(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM meetings ORDER BY scheduled_at DESC, created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def update_meeting(self, meeting_id: int, **kwargs) -> None:
        allowed = {"title", "status", "scheduled_at"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        self._conn.execute(
            f"UPDATE meetings SET {sets} WHERE id=?",
            (*fields.values(), meeting_id)
        )
        self._conn.commit()

    def delete_meeting(self, meeting_id: int) -> None:
        self._conn.execute("DELETE FROM meetings WHERE id=?", (meeting_id,))
        self._conn.commit()

    def add_meeting_member(self, meeting_id: int, person_name: str,
                           role: str, person_id: int | None = None) -> int:
        cur = self._conn.execute(
            "INSERT INTO meeting_members (meeting_id, person_id, person_name, role) VALUES (?,?,?,?)",
            (meeting_id, person_id, person_name, role)
        )
        self._conn.commit()
        return cur.lastrowid

    def list_meeting_members(self, meeting_id: int) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM meeting_members WHERE meeting_id=? ORDER BY id",
            (meeting_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def remove_meeting_member(self, meeting_id: int, person_name: str) -> None:
        self._conn.execute(
            "DELETE FROM meeting_members WHERE meeting_id=? AND person_name=?",
            (meeting_id, person_name)
        )
        self._conn.commit()

    def add_meeting_task(self, meeting_id: int, task_id: int, wi_title: str) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO meeting_tasks (meeting_id, task_id, wi_title) VALUES (?,?,?)",
            (meeting_id, task_id, wi_title)
        )
        self._conn.commit()

    def list_meeting_tasks(self, meeting_id: int) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM meeting_tasks WHERE meeting_id=? ORDER BY id",
            (meeting_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def remove_meeting_task(self, meeting_id: int, task_id: int) -> None:
        self._conn.execute(
            "DELETE FROM meeting_tasks WHERE meeting_id=? AND task_id=?",
            (meeting_id, task_id)
        )
        self._conn.commit()

    def upsert_meeting_notes(self, meeting_id: int, content: str) -> int:
        existing = self._conn.execute(
            "SELECT id FROM meeting_notes WHERE meeting_id=?", (meeting_id,)
        ).fetchone()
        if existing:
            self._conn.execute(
                "UPDATE meeting_notes SET content=? WHERE meeting_id=?",
                (content, meeting_id)
            )
            self._conn.commit()
            return existing[0]
        cur = self._conn.execute(
            "INSERT INTO meeting_notes (meeting_id, content) VALUES (?,?)",
            (meeting_id, content)
        )
        self._conn.commit()
        return cur.lastrowid

    def get_meeting_notes(self, meeting_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM meeting_notes WHERE meeting_id=?", (meeting_id,)
        ).fetchone()
        return dict(row) if row else None

    def get_meeting_full(self, meeting_id: int) -> dict | None:
        """Return meeting + members + tasks + notes in one call."""
        m = self.get_meeting(meeting_id)
        if not m:
            return None
        m['members'] = self.list_meeting_members(meeting_id)
        m['tasks'] = self.list_meeting_tasks(meeting_id)
        m['notes'] = self.get_meeting_notes(meeting_id)
        return m

    # ── Work Items ───────────────────────────────────────────────────────────

    def add_work_item(self, title: str, type: str, parent_id: int | None = None,
                      importance: int = 3, urgency: int = 3,
                      deadline: str | None = None, status: str = "active") -> int:
        cur = self._conn.execute(
            """INSERT INTO work_items (title, type, parent_id, importance, urgency, deadline, status)
               VALUES (?,?,?,?,?,?,?)""",
            (title, type, parent_id, importance, urgency, deadline, status)
        )
        self._conn.commit()
        return cur.lastrowid

    def get_work_item(self, item_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM work_items WHERE id=?", (item_id,)
        ).fetchone()
        return dict(row) if row else None

    def get_work_item_by_title(self, title: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM work_items WHERE title=? AND is_deleted=0 ORDER BY id DESC LIMIT 1",
            (title,)
        ).fetchone()
        return dict(row) if row else None

    def list_work_items(self, include_deleted: bool = False) -> list[dict]:
        sql = "SELECT * FROM work_items"
        if not include_deleted:
            sql += " WHERE is_deleted=0"
        sql += " ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, importance DESC, urgency DESC"
        return [dict(r) for r in self._conn.execute(sql).fetchall()]

    def update_work_item(self, item_id: int, **kwargs) -> None:
        allowed = {"title", "importance", "urgency", "deadline", "status", "parent_id", "sort_order"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        self._conn.execute(
            f"UPDATE work_items SET {sets} WHERE id=?",
            (*fields.values(), item_id)
        )
        self._conn.commit()

    # ── Tasks ────────────────────────────────────────────────────────────────

    def add_task(self, title: str, work_item_id: int | None = None,
                 ownership: str = "self_lead", due_date: str | None = None,
                 status: str = "todo", priority: int = 0) -> int:
        cur = self._conn.execute(
            "INSERT INTO tasks (title, work_item_id, ownership, due_date, status, priority) VALUES (?,?,?,?,?,?)",
            (title, work_item_id, ownership, due_date, status, priority)
        )
        self._conn.commit()
        return cur.lastrowid

    def get_task(self, task_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM tasks WHERE id=? AND is_deleted=0", (task_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_tasks(self, work_item_id: int | None = None,
                   include_deleted: bool = False) -> list[dict]:
        conditions = [] if include_deleted else ["is_deleted=0"]
        params: list = []
        if work_item_id is not None:
            conditions.append("work_item_id=?")
            params.append(work_item_id)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        return [dict(r) for r in self._conn.execute(
            f"SELECT * FROM tasks {where} ORDER BY due_date ASC", params
        ).fetchall()]

    def update_task(self, task_id: int, **kwargs) -> None:
        allowed = {"title", "ownership", "due_date", "status", "work_item_id", "priority",
                   "parent_task_id", "follows_task_id"}
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        self._conn.execute(
            f"UPDATE tasks SET {sets} WHERE id=?",
            (*fields.values(), task_id)
        )
        self._conn.commit()

    def delete_task(self, task_id: int) -> None:
        self._conn.execute("UPDATE tasks SET is_deleted=1 WHERE id=?", (task_id,))
        self._conn.commit()

    def delete_work_item(self, work_item_id: int) -> None:
        self._conn.execute("UPDATE work_items SET is_deleted=1 WHERE id=?", (work_item_id,))
        self._conn.execute(
            "UPDATE tasks SET is_deleted=1 WHERE work_item_id=?", (work_item_id,)
        )
        self._conn.commit()

    # ── Task Assignments ─────────────────────────────────────────────────────

    def add_assignment(self, task_id: int, person_id: int | None,
                       role_in_task: str) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO task_assignments (task_id, person_id, role_in_task) VALUES (?,?,?)",
            (task_id, person_id, role_in_task)
        )
        self._conn.commit()

    def get_assignments(self, task_id: int) -> list[dict]:
        rows = self._conn.execute(
            """SELECT ta.*, p.name as person_name
               FROM task_assignments ta
               LEFT JOIN people p ON ta.person_id = p.id
               WHERE ta.task_id=?""",
            (task_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def remove_assignment(self, task_id: int, person_id: int | None, role_in_task: str) -> bool:
        cur = self._conn.execute(
            "DELETE FROM task_assignments WHERE task_id=? AND person_id=? AND role_in_task=?",
            (task_id, person_id, role_in_task)
        )
        self._conn.commit()
        return cur.rowcount > 0

    # ── Daily Inputs ─────────────────────────────────────────────────────────

    def save_input(self, raw_text: str, parsed_json: str = "") -> int:
        cur = self._conn.execute(
            "INSERT INTO daily_inputs (raw_text, parsed_json, confirmed) VALUES (?,?,0)",
            (raw_text, parsed_json)
        )
        self._conn.commit()
        return cur.lastrowid

    def confirm_input(self, input_id: int) -> None:
        self._conn.execute(
            "UPDATE daily_inputs SET confirmed=1 WHERE id=?", (input_id,)
        )
        self._conn.commit()

    def get_recent_inputs(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM daily_inputs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Soft Delete (universal) ───────────────────────────────────────────────

    def soft_delete(self, table: str, record_id: int) -> None:
        allowed_tables = {"people", "work_items", "tasks"}
        if table not in allowed_tables:
            raise ValueError(f"soft_delete not supported for table: {table}")
        self._conn.execute(
            f"UPDATE {table} SET is_deleted=1 WHERE id=?", (record_id,)
        )
        self._conn.commit()

    def get_trash(self) -> dict:
        work_items = [dict(r) for r in self._conn.execute(
            "SELECT * FROM work_items WHERE is_deleted=1 ORDER BY id DESC"
        ).fetchall()]
        for wi in work_items:
            row = self._conn.execute(
                "SELECT COUNT(*) FROM tasks WHERE work_item_id=? AND is_deleted=1",
                (wi["id"],)
            ).fetchone()
            wi["deleted_task_count"] = row[0]

        tasks = [dict(r) for r in self._conn.execute(
            """SELECT t.* FROM tasks t
               LEFT JOIN work_items w ON t.work_item_id = w.id
               WHERE t.is_deleted=1 AND (w.is_deleted=0 OR w.id IS NULL)
               ORDER BY t.id DESC"""
        ).fetchall()]
        return {"work_items": work_items, "tasks": tasks}

    def restore_item(self, table: str, record_id: int) -> bool:
        allowed_tables = {"work_items", "tasks"}
        if table not in allowed_tables:
            raise ValueError(f"restore_item not supported for table: {table}")
        cur = self._conn.execute(
            f"UPDATE {table} SET is_deleted=0 WHERE id=? AND is_deleted=1", (record_id,)
        )
        # Cascade-restore tasks when restoring a work_item
        if table == "work_items" and cur.rowcount > 0:
            self._conn.execute(
                "UPDATE tasks SET is_deleted=0 WHERE work_item_id=? AND is_deleted=1",
                (record_id,)
            )
        self._conn.commit()
        return cur.rowcount > 0

    # ── DB Context (for AI parser) ────────────────────────────────────────────

    def get_db_context(self) -> dict:
        """Returns a lightweight summary of current DB state for AI context.
        Intentionally limited to people and work_items — tasks are too numerous
        to include in every AI prompt."""
        return {
            "people": self.list_people(),
            "work_items": self.list_work_items(),
        }

    # ── Workflow Nodes ────────────────────────────────────────────────────────

    def add_workflow_node(self, task_id: int, title: str,
                          parent_node_id: int | None = None,
                          depends_on_id: int | None = None,
                          time_estimate: int | None = None,
                          position: int = 0) -> int:
        cur = self._conn.execute(
            """INSERT INTO workflow_nodes
               (task_id, title, parent_node_id, depends_on_id, time_estimate, position)
               VALUES (?,?,?,?,?,?)""",
            (task_id, title, parent_node_id, depends_on_id, time_estimate, position)
        )
        self._conn.commit()
        return cur.lastrowid

    def get_workflow_node(self, node_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM workflow_nodes WHERE id=? AND is_deleted=0", (node_id,)
        ).fetchone()
        return dict(row) if row else None

    def list_workflow_nodes(self, task_id: int) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM workflow_nodes WHERE task_id=? AND is_deleted=0 ORDER BY position ASC",
            (task_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def update_workflow_node(self, node_id: int, **kwargs) -> None:
        allowed = {
            "title", "status", "time_estimate", "position", "depends_on_id",
            "pos_x", "pos_y", "assignee", "due_date", "custom_tags", "collapsed",
        }
        fields = {k: v for k, v in kwargs.items() if k in allowed}
        if not fields:
            return
        sets = ", ".join(f"{k}=?" for k in fields)
        self._conn.execute(
            f"UPDATE workflow_nodes SET {sets} WHERE id=?",
            (*fields.values(), node_id)
        )
        self._conn.commit()

    def delete_workflow_node(self, node_id: int) -> None:
        # Cascade soft-delete to all descendants and their edges
        def _delete_recursive(nid: int) -> None:
            children = self._conn.execute(
                "SELECT id FROM workflow_nodes WHERE parent_node_id=? AND is_deleted=0",
                (nid,)
            ).fetchall()
            for row in children:
                _delete_recursive(row[0])
            self._conn.execute(
                "UPDATE workflow_nodes SET is_deleted=1 WHERE id=?", (nid,)
            )
            # Soft-delete edges connected to this node
            self._conn.execute(
                "UPDATE workflow_edges SET is_deleted=1 WHERE source_node_id=? OR target_node_id=?",
                (nid, nid)
            )
        _delete_recursive(node_id)
        self._conn.commit()

    # ── Workflow Edges ────────────────────────────────────────────────────────

    def add_workflow_edge(self, source_id: int, target_id: int, edge_type: str = "sequence") -> int:
        cur = self._conn.execute(
            """INSERT INTO workflow_edges (source_node_id, target_node_id, edge_type)
               VALUES (?, ?, ?)
               ON CONFLICT(source_node_id, target_node_id) DO UPDATE SET
                   is_deleted=0, edge_type=excluded.edge_type""",
            (source_id, target_id, edge_type)
        )
        self._conn.commit()
        return cur.lastrowid

    def list_workflow_edges(self, task_id: int) -> list[dict]:
        rows = self._conn.execute(
            """SELECT e.id, e.source_node_id, e.target_node_id, e.edge_type
               FROM workflow_edges e
               JOIN workflow_nodes s ON s.id = e.source_node_id
               JOIN workflow_nodes t ON t.id = e.target_node_id
               WHERE s.task_id=? AND t.task_id=? AND e.is_deleted=0
                 AND s.is_deleted=0 AND t.is_deleted=0""",
            (task_id, task_id)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_workflow_edge(self, edge_id: int) -> dict | None:
        row = self._conn.execute(
            "SELECT id FROM workflow_edges WHERE id=? AND is_deleted=0", (edge_id,)
        ).fetchone()
        return dict(row) if row else None

    def delete_workflow_edge(self, edge_id: int) -> None:
        self._conn.execute(
            "UPDATE workflow_edges SET is_deleted=1 WHERE id=?", (edge_id,)
        )
        self._conn.commit()

    # ── Schedule Entries ─────────────────────────────────────────────────────

    def add_or_update_schedule_entry(self, task_id: int, is_current: int,
                                     date_start: str | None = None,
                                     date_end: str | None = None) -> None:
        self._conn.execute(
            """INSERT INTO schedule_entries (task_id, is_current, date_start, date_end)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(task_id) DO UPDATE SET
                   is_current=excluded.is_current,
                   date_start=excluded.date_start,
                   date_end=excluded.date_end""",
            (task_id, is_current, date_start, date_end)
        )
        self._conn.commit()

    def delete_schedule_entry(self, task_id: int) -> bool:
        cur = self._conn.execute(
            "DELETE FROM schedule_entries WHERE task_id=?", (task_id,)
        )
        self._conn.commit()
        return cur.rowcount > 0

    def list_schedule_entries(self) -> dict:
        rows = self._conn.execute(
            "SELECT task_id, is_current, date_start, date_end FROM schedule_entries"
        ).fetchall()
        return {
            row["task_id"]: {
                "is_current": row["is_current"],
                "date_start": row["date_start"],
                "date_end": row["date_end"],
            }
            for row in rows
        }

    # ── Node Schedule Entries ────────────────────────────────────────────────

    def add_or_update_node_entry(self, node_id: int, is_current: int,
                                  date_start: str | None = None,
                                  date_end: str | None = None) -> None:
        self._conn.execute(
            """INSERT INTO node_schedule_entries (node_id, is_current, date_start, date_end)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(node_id) DO UPDATE SET
                   is_current=excluded.is_current,
                   date_start=excluded.date_start,
                   date_end=excluded.date_end""",
            (node_id, is_current, date_start, date_end)
        )
        self._conn.commit()

    def delete_node_entry(self, node_id: int) -> bool:
        cur = self._conn.execute(
            "DELETE FROM node_schedule_entries WHERE node_id=?", (node_id,)
        )
        self._conn.commit()
        return cur.rowcount > 0

    def list_node_entries(self) -> dict:
        rows = self._conn.execute(
            "SELECT node_id, is_current, date_start, date_end FROM node_schedule_entries"
        ).fetchall()
        return {
            row["node_id"]: {
                "is_current": row["is_current"],
                "date_start": row["date_start"],
                "date_end": row["date_end"],
            }
            for row in rows
        }
