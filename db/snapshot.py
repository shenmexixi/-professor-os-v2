# professor-os/db/snapshot.py
import json
import sqlite3
from datetime import datetime
from pathlib import Path


def create_snapshot(conn: sqlite3.Connection, input_id: int | None,
                    snapshots_dir: str | Path) -> Path:
    """Dump all rows from all tables to a JSON file. Returns path to snapshot."""
    snapshots_dir = Path(snapshots_dir)
    snapshots_dir.mkdir(parents=True, exist_ok=True)

    conn.row_factory = sqlite3.Row
    tables = ["people", "work_items", "tasks", "task_assignments", "daily_inputs"]
    data: dict = {}
    for table in tables:
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        data[table] = [dict(r) for r in rows]

    data["_meta"] = {
        "created_at": datetime.now().isoformat(),
        "trigger_input_id": input_id,
    }

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = snapshots_dir / f"snapshot_{timestamp}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    # Record in db_snapshots table
    conn.execute(
        "INSERT INTO db_snapshots (trigger_input_id, snapshot_json) VALUES (?,?)",
        (input_id, str(path))
    )
    conn.commit()
    return path


def restore_snapshot(conn: sqlite3.Connection, snapshot_path: str | Path) -> None:
    """Restore DB to state captured in snapshot. Replaces all rows."""
    data = json.loads(Path(snapshot_path).read_text(encoding="utf-8"))

    tables_in_order = ["task_assignments", "tasks", "work_items", "people", "daily_inputs", "db_snapshots"]
    try:
        for table in tables_in_order:
            conn.execute(f"DELETE FROM {table}")

        for table in reversed(tables_in_order):
            rows = data.get(table, [])
            if not rows:
                continue
            cols = ", ".join(rows[0].keys())
            placeholders = ", ".join("?" for _ in rows[0])
            conn.executemany(
                f"INSERT INTO {table} ({cols}) VALUES ({placeholders})",
                [list(r.values()) for r in rows]
            )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
