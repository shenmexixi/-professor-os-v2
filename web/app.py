# web/app.py
import asyncio
import sqlite3
import webbrowser
import threading
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from sse_starlette.sse import EventSourceResponse

import config
from db.models import init_db
from db.repository import Repository


def create_app(repo: Repository, conn: sqlite3.Connection) -> FastAPI:
    app = FastAPI(title="Professor OS")

    # Store shared state on app
    app.state.repo = repo
    app.state.conn = conn
    app.state.sse_subscribers: list = []

    # Provider is set here; can be overridden in tests
    app.state.provider = None
    app.state.provider_error = None
    try:
        if config.LLM_PROVIDER == "deepseek":
            from parser.llm.deepseek import DeepSeekProvider
            app.state.provider = DeepSeekProvider()
        else:
            from parser.llm.claude import ClaudeProvider
            app.state.provider = ClaudeProvider()
    except Exception as e:
        import traceback
        app.state.provider_error = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"

    # Mount static files
    static_dir = Path(__file__).parent / "static"
    static_dir.mkdir(exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    @app.get("/")
    async def root():
        return RedirectResponse(url="/static/index.html")

    @app.get("/api/events")
    async def sse_events(request: Request):
        queue: asyncio.Queue = asyncio.Queue()
        app.state.sse_subscribers.append(queue)

        async def event_generator():
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        msg = queue.get_nowait()
                        if msg == "schedule_updated":
                            yield {"event": "schedule_updated", "data": ""}
                        else:
                            # Generic data message (e.g. pref:...)
                            yield {"data": msg}
                    except asyncio.QueueEmpty:
                        await asyncio.sleep(0.5)
            finally:
                if queue in app.state.sse_subscribers:
                    app.state.sse_subscribers.remove(queue)

        return EventSourceResponse(event_generator())

    # Register routers (imported here to avoid circular imports)
    from web.api.schedule import router as schedule_router
    from web.api.input import router as input_router
    from web.api.confirm import router as confirm_router
    from web.api.misc import router as misc_router

    app.include_router(schedule_router, prefix="/api")
    app.include_router(input_router, prefix="/api")
    app.include_router(confirm_router, prefix="/api")
    app.include_router(misc_router, prefix="/api")

    from web.api.workflow import router as workflow_router
    app.include_router(workflow_router, prefix="/api")

    from web.api.task import router as task_router
    from web.api.work_item import router as work_item_router

    app.include_router(task_router, prefix="/api")
    app.include_router(work_item_router, prefix="/api")

    from web.api.dedup import router as dedup_router
    app.include_router(dedup_router, prefix="/api")

    from web.api.trash import router as trash_router
    app.include_router(trash_router, prefix="/api")

    from web.api.assignment import router as assignment_router
    app.include_router(assignment_router, prefix="/api")

    from web.api.schedule_plan import router as schedule_plan_router
    app.include_router(schedule_plan_router, prefix="/api")

    from web.api.people import router as people_router
    app.include_router(people_router, prefix="/api")

    from web.api.meetings import router as meetings_router
    app.include_router(meetings_router, prefix="/api")

    from web.api.export import router as export_router
    app.include_router(export_router, prefix="/api")

    from web.api.tray_pref import router as tray_pref_router
    app.include_router(tray_pref_router, prefix="/api")

    return app


def main():
    import uvicorn

    conn = init_db(config.DB_PATH)
    repo = Repository(conn)
    app = create_app(repo=repo, conn=conn)

    print(f"[config] KEY={config.ANTHROPIC_API_KEY[:20]}... MODEL={config.ANTHROPIC_MODEL}")

    def open_browser():
        import time
        time.sleep(1)
        webbrowser.open("http://localhost:8000")

    threading.Thread(target=open_browser, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()


# Module-level app instance for uvicorn (e.g. uvicorn web.app:app)
def _make_app():
    conn = init_db(config.DB_PATH)
    repo = Repository(conn)
    return create_app(repo=repo, conn=conn)


app = _make_app()
