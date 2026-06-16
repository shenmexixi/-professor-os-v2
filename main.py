import os
import sys
import shutil
import webbrowser
import threading
import time
from pathlib import Path

# When packaged as a windowless exe (console=False), stdout/stderr are None.
# Redirect them to devnull so logging/uvicorn don't crash on .isatty().
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w')

from config import config
from config_ui import show_config_window
from db.models import init_db


def ensure_database():
    """Ensure database exists; copy from blank.db template if not."""
    if not config.db_path.exists():
        blank_db = Path(__file__).parent / 'data' / 'blank.db'
        if blank_db.exists():
            shutil.copy(blank_db, config.db_path)
        else:
            init_db(str(config.db_path))


_server = None  # uvicorn Server instance


def start_server():
    """Start uvicorn in a background thread, return when ready."""
    import uvicorn
    from web.app import app

    global _server
    cfg = uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="warning")
    _server = uvicorn.Server(cfg)

    thread = threading.Thread(target=_server.run, daemon=True)
    thread.start()

    # Wait until server is ready (max 10s)
    for _ in range(100):
        if _server.started:
            return
        time.sleep(0.1)


def open_browser_delayed():
    time.sleep(0.3)
    webbrowser.open("http://127.0.0.1:8000")


def quit_app():
    """Gracefully stop server and exit."""
    global _server
    if _server:
        _server.should_exit = True
    time.sleep(0.5)
    os._exit(0)


def reopen_config():
    """Re-open config window (called from tray menu)."""
    show_config_window()
    # Rebuild provider with new config
    from web.app import app as _app
    _app.state.provider = None
    _app.state.provider_error = None
    try:
        if config.provider == "deepseek":
            from parser.llm.deepseek import DeepSeekProvider
            _app.state.provider = DeepSeekProvider()
        else:
            from parser.llm.claude import ClaudeProvider
            _app.state.provider = ClaudeProvider()
    except Exception as e:
        import traceback
        _app.state.provider_error = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"


def main():
    # 1. Check configuration
    if not config.is_configured:
        skipped = show_config_window()
        if not skipped and not config.is_configured:
            sys.exit(0)

    # 2. Ensure database exists
    ensure_database()

    # 3. Set environment variables for legacy modules
    os.environ['ANTHROPIC_API_KEY'] = config.api_key
    os.environ['DB_PATH'] = str(config.db_path)

    # 4. Start server in background thread
    start_server()

    # 5. Open browser once server is up
    threading.Thread(target=open_browser_delayed, daemon=True).start()

    # 6. Run system tray in main thread (blocking)
    from tray import run_tray
    run_tray(
        on_quit=quit_app,
        on_open_config=reopen_config,
        server_url="http://127.0.0.1:8000",
    )


if __name__ == "__main__":
    main()
