# professor-os/db/models.py
import sqlite3
from pathlib import Path


def init_db(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS people (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            role        TEXT NOT NULL CHECK(role IN ('undergraduate','master','phd','collaborator_teacher','clinician','peer','other')),
            expertise   TEXT,
            bandwidth   INTEGER DEFAULT 100 CHECK(bandwidth BETWEEN 0 AND 100),
            is_deleted  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS work_items (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            type        TEXT NOT NULL CHECK(type IN ('project','paper','teaching','learning','routine')),
            parent_id   INTEGER REFERENCES work_items(id),
            importance  INTEGER DEFAULT 3 CHECK(importance BETWEEN 1 AND 5),
            urgency     INTEGER DEFAULT 3 CHECK(urgency BETWEEN 1 AND 5),
            deadline    TEXT,
            status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
            is_deleted  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            work_item_id    INTEGER REFERENCES work_items(id),
            title           TEXT NOT NULL,
            ownership       TEXT NOT NULL DEFAULT 'self_lead'
                                CHECK(ownership IN ('self_lead','delegated','supervised')),
            due_date        TEXT,
            status          TEXT NOT NULL DEFAULT 'todo'
                                CHECK(status IN ('todo','in_progress','done','archived')),
            priority        INTEGER NOT NULL DEFAULT 0,
            is_deleted      INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS task_assignments (
            task_id         INTEGER NOT NULL REFERENCES tasks(id),
            person_id       INTEGER REFERENCES people(id),
            role_in_task    TEXT NOT NULL CHECK(role_in_task IN ('owner','stakeholder','executor')),
            PRIMARY KEY (task_id, person_id, role_in_task)
        );

        CREATE TABLE IF NOT EXISTS daily_inputs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            raw_text    TEXT NOT NULL,
            parsed_json TEXT,
            confirmed   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS db_snapshots (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            trigger_input_id    INTEGER REFERENCES daily_inputs(id),
            snapshot_json       TEXT NOT NULL,
            created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS workflow_nodes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id         INTEGER NOT NULL REFERENCES tasks(id),
            parent_node_id  INTEGER REFERENCES workflow_nodes(id),
            depends_on_id   INTEGER REFERENCES workflow_nodes(id),
            title           TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'todo'
                                CHECK(status IN ('todo','done','kept','skipped')),
            time_estimate   INTEGER,
            position        INTEGER NOT NULL DEFAULT 0,
            is_deleted      INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
    """)
    # Safe migrations — workflow_nodes canvas columns
    wf_cols = {row[1] for row in conn.execute("PRAGMA table_info(workflow_nodes)").fetchall()}
    wf_migrations = [
        ("pos_x",      "REAL NOT NULL DEFAULT 0"),
        ("pos_y",      "REAL NOT NULL DEFAULT 0"),
        ("assignee",   "TEXT"),
        ("due_date",   "TEXT"),
        ("custom_tags","TEXT"),
        ("collapsed",  "INTEGER NOT NULL DEFAULT 0"),
    ]
    for col, definition in wf_migrations:
        if col not in wf_cols:
            conn.execute(f"ALTER TABLE workflow_nodes ADD COLUMN {col} {definition}")

    # workflow_edges table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS workflow_edges (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            source_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
            target_node_id INTEGER NOT NULL REFERENCES workflow_nodes(id),
            edge_type      TEXT NOT NULL DEFAULT 'sequence'
                               CHECK(edge_type IN ('sequence', 'dependency')),
            is_deleted     INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(source_node_id, target_node_id)
        )
    """)

    # Schedule entries table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schedule_entries (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id    INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
            is_current INTEGER NOT NULL DEFAULT 1,
            date_start TEXT,
            date_end   TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
    """)

    # Safe migration — extend people.role enum to include degree levels
    # Recreate people table with updated CHECK constraint
    try:
        cur = conn.execute("INSERT INTO people (name, role, expertise, bandwidth) VALUES ('__probe__','undergraduate','',0)")
        conn.execute("DELETE FROM people WHERE id=?", (cur.lastrowid,))
        conn.commit()
    except sqlite3.IntegrityError:
        # Old constraint — recreate table; use executescript (auto-commits) with FK off
        conn.executescript("""
            PRAGMA foreign_keys=OFF;
            CREATE TABLE IF NOT EXISTS people_new (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                role        TEXT NOT NULL CHECK(role IN (
                                'undergraduate','master','phd',
                                'collaborator_teacher','clinician','peer','other')),
                expertise   TEXT,
                bandwidth   INTEGER DEFAULT 100 CHECK(bandwidth BETWEEN 0 AND 100),
                is_deleted  INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO people_new (id, name, role, expertise, bandwidth, is_deleted)
                SELECT id,
                       name,
                       CASE WHEN role='student' THEN 'master' ELSE role END,
                       expertise,
                       bandwidth,
                       is_deleted
                FROM people;
            DROP TABLE people;
            ALTER TABLE people_new RENAME TO people;
            PRAGMA foreign_keys=ON;
        """)
    conn.commit()

    # Node schedule entries table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS node_schedule_entries (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id    INTEGER NOT NULL UNIQUE REFERENCES workflow_nodes(id),
            is_current INTEGER NOT NULL DEFAULT 1,
            date_start TEXT,
            date_end   TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
    """)

    # Safe migrations — work_items columns
    wi_cols = {row[1] for row in conn.execute("PRAGMA table_info(work_items)").fetchall()}
    if "sort_order" not in wi_cols:
        conn.execute("ALTER TABLE work_items ADD COLUMN sort_order INTEGER")

    # Safe migrations — tasks columns
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    if "priority" not in existing_cols:
        conn.execute("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")
    for col in ("parent_task_id", "follows_task_id"):
        if col not in existing_cols:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} INTEGER REFERENCES tasks(id)")
    conn.commit()

    # ── Meeting tables ────────────────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meetings (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            title        TEXT NOT NULL DEFAULT '新会议',
            status       TEXT NOT NULL DEFAULT 'planned'
                             CHECK(status IN ('planned','in_progress','done')),
            scheduled_at TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meeting_members (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            person_id   INTEGER REFERENCES people(id),
            person_name TEXT NOT NULL,
            role        TEXT NOT NULL CHECK(role IN ('organizer','participant','reporter'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meeting_tasks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            wi_title    TEXT NOT NULL DEFAULT '',
            UNIQUE(meeting_id, task_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meeting_notes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            content     TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.commit()
    return conn
