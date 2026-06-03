"""
System tray icon for Professor OS.
Provides: open browser, open config, restart, quit.
"""
import threading
import webbrowser
import sys
from PIL import Image, ImageDraw


def _make_icon_image():
    """Generate a simple colored square as tray icon."""
    size = 64
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Dark background circle
    draw.ellipse([2, 2, size - 2, size - 2], fill=(30, 30, 30, 255))
    # "P" letter in green
    draw.rectangle([18, 14, 26, 50], fill=(63, 185, 80, 255))
    draw.rectangle([18, 14, 40, 22], fill=(63, 185, 80, 255))
    draw.rectangle([18, 30, 40, 38], fill=(63, 185, 80, 255))
    draw.ellipse([26, 14, 46, 38], fill=(63, 185, 80, 255))
    draw.ellipse([28, 16, 44, 36], fill=(30, 30, 30, 255))
    return img


def run_tray(on_quit, on_open_config, server_url="http://127.0.0.1:8000"):
    """
    Start the system tray icon in the current thread (blocking).

    on_quit        -- callable, stops the server and exits the app
    on_open_config -- callable, opens the config window
    server_url     -- URL to open in browser
    """
    import pystray

    def open_browser(icon, item):
        webbrowser.open(server_url)

    def open_config(icon, item):
        # Run config window in main thread via a flag; simpler: just open directly
        threading.Thread(target=_open_config_threadsafe, args=(on_open_config,), daemon=True).start()

    def quit_app(icon, item):
        icon.stop()
        on_quit()

    def _open_config_threadsafe(fn):
        try:
            fn()
        except Exception:
            pass

    menu = pystray.Menu(
        pystray.MenuItem('打开主界面', open_browser, default=True),
        pystray.MenuItem('重新配置 API', open_config),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('退出', quit_app),
    )

    icon = pystray.Icon(
        name='ProfessorOS',
        icon=_make_icon_image(),
        title='Professor OS',
        menu=menu,
    )

    icon.run()
