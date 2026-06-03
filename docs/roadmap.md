# Professor OS — Development Roadmap

## Phase 1: Single-User Desktop App (Current)

A self-contained Windows `.exe` that any professor can run without installing Python.

**Status:** Active development

### What It Does

- Double-click to launch; first run shows API Key configuration window
- FastAPI server starts on `127.0.0.1:8000`; browser opens automatically
- All data stored locally in `%APPDATA%\ProfessorOS\`
- CLI tools to export/import task data between instances

### Stack

- **Backend:** FastAPI + uvicorn (embedded)
- **Database:** SQLite (single file)
- **Config UI:** tkinter (stdlib, no extra deps)
- **Packaging:** PyInstaller (`--onefile`)

---

## Phase 2: Pseudo Multi-User Network Version (Planned)

Multiple professors each get their own isolated instance, accessed over a local network. No shared data — each user gets their own SQLite database.

**Status:** Planned, not started

### Architecture

```
[Client Browser] → [Nginx: Basic Auth] → [FastAPI app]
                                              ↓
                                   select data/<username>.db
                                   based on authenticated username
```

### Key Changes from Phase 1

- `main.py` runs in "server mode" — binds `0.0.0.0`, no browser auto-open
- `auth_middleware.py` extracts username from `Authorization: Basic` header
- `web/app.py` creates `Repository` per-request from per-user DB path
- Admin CLI: `python tools/manage_accounts.py add <username>`
  copies `blank.db` to `data/<username>.db`
- Nginx config template in `deploy/nginx.conf`
- systemd unit file in `deploy/professor-os.service`

### What Does NOT Change

- Repository layer (zero changes — each request points to a different DB file)
- Frontend (zero changes)
- All existing API endpoints
- DB schema

---

## Phase 3: True Multi-User Collaborative Platform (Deferred)

**Status:** Design only. Implementation deferred until Phase 2 is validated in production.

### Scope

- **Database:** Migrate SQLite → PostgreSQL. Add `owner_id INTEGER` to
  `work_items`, `tasks`, `people`, `meetings`, `daily_inputs`
- **Authentication:** JWT tokens via `fastapi-users`
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `POST /api/auth/refresh`
- **Repository layer:** All ~45 query methods gain `owner_id: int` parameter
- **Workspace model:** New `workspaces` and `workspace_members` tables.
  Tasks/work_items can belong to a workspace (shared) or a single owner (private)
- **Real-time collaboration:** SSE events broadcast to all workspace members
- **Deployment:** Docker Compose — `app` + `postgres` + `nginx` services

### Migration Path from Phase 2

- Export all per-user SQLite DBs via migration script → PostgreSQL schema
- Each Phase 2 user becomes a Phase 3 user with `owner_id`
- Per-user data maps to a personal workspace

---

## Development Rules

1. **Never modify** `D:\Projects\School manager\professor-os` (the test version)
2. Phase 1 repo is `professor-os-v2`, independent git history
3. Phase 2 is a new branch or new repo from Phase 1 — decided at Phase 2 start
4. Phase 3 is a greenfield project, not a branch of Phase 2
