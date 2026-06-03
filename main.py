import os
import sys
import shutil
import webbrowser
import threading
import time
from pathlib import Path
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
            print(f"✓ 已初始化数据库: {config.db_path}")
        else:
            # If blank template doesn't exist, create new database
            init_db(str(config.db_path))
            print(f"✓ 已创建新数据库: {config.db_path}")


def open_browser():
    """Delay then open browser to application."""
    time.sleep(2)
    webbrowser.open("http://127.0.0.1:8000")


def main():
    # 1. Check configuration
    if not config.is_configured:
        show_config_window()
        if not config.is_configured:
            print("配置已取消，退出程序")
            sys.exit(0)

    # 2. Ensure database exists
    ensure_database()

    # 3. Set environment variables for other modules
    os.environ['ANTHROPIC_API_KEY'] = config.api_key
    os.environ['DB_PATH'] = str(config.db_path)

    # 4. Start browser in background
    threading.Thread(target=open_browser, daemon=True).start()

    # 5. Start web application
    print("=" * 50)
    print("Professor OS 正在启动...")
    print(f"数据库: {config.db_path}")
    print(f"访问地址: http://127.0.0.1:8000")
    print("=" * 50)

    from web.app import app
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
