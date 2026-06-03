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
import uvicorn


def ensure_database():
    """Ensure database exists; copy from blank.db template if not."""
    if not config.db_path.exists():
        blank_db = Path(__file__).parent / 'data' / 'blank.db'
        if blank_db.exists():
            shutil.copy(blank_db, config.db_path)
        else:
            init_db(str(config.db_path))


def open_browser():
    time.sleep(2)
    webbrowser.open("http://127.0.0.1:8000")


def main():
    # 1. Check configuration — show window if not yet configured
    if not config.is_configured:
        skipped = show_config_window()
        # If user clicked Skip: launch without AI features
        # If user closed window without saving: exit
        if not skipped and not config.is_configured:
            sys.exit(0)

    # 2. Ensure database exists
    ensure_database()

    # 3. Set environment variables for legacy modules
    os.environ['ANTHROPIC_API_KEY'] = config.api_key
    os.environ['DB_PATH'] = str(config.db_path)

    # 4. Open browser after short delay
    threading.Thread(target=open_browser, daemon=True).start()

    # 5. Start web application
    from web.app import app
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")


if __name__ == "__main__":
    main()
