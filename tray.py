"""
System tray icon for Professor OS.
Menu: open browser, themes, font sizes, reconfig API, quit.
"""
import threading
import webbrowser
import sys
from PIL import Image, ImageDraw, ImageFont


def _make_icon_image():
    """
    Draw a rounded square with a stylised 'P' monogram.
    Dark background, green accent — matches the app's default theme.
    """
    S = 128
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background: rounded rectangle (dark)
    r = 28
    bg = (22, 27, 34, 255)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=bg)

    # Green accent bar on left edge
    accent = (63, 185, 80, 255)
    d.rounded_rectangle([0, 0, 10, S - 1], radius=4, fill=accent)

    # White 'P' using basic geometry (no font needed)
    px, py = 28, 24          # top-left of the P stem
    sw = 10                  # stem width
    pw = 42                  # total P width
    ph = S - 48              # total P height
    bh = ph // 2 - 4         # bowl height
    br = (pw - sw) // 2      # bowl radius

    white = (230, 237, 243, 255)

    # Vertical stem
    d.rectangle([px, py, px + sw, py + ph], fill=white)

    # Bowl: filled semicircle on the right of the stem
    d.ellipse([px + sw - 4, py, px + sw - 4 + (br * 2), py + bh * 2],
              fill=white)
    # Cut out inner bowl to make it hollow-ish (outline effect)
    inner = (22, 27, 34, 255)
    d.ellipse([px + sw + 4, py + 8, px + sw + 4 + (br * 2 - 16), py + bh * 2 - 8],
              fill=inner)

    return img


def run_tray(on_quit, on_open_config, server_url="http://127.0.0.1:8000"):
    """
    Start the system tray icon in the current thread (blocking).
    """
    import pystray

    def open_browser(icon=None, item=None):
        webbrowser.open(server_url)

    def set_theme(theme):
        def _do(icon, item):
            webbrowser.open(f"{server_url}?set_theme={theme}")
        return _do

    def set_fontsize(size):
        def _do(icon, item):
            webbrowser.open(f"{server_url}?set_fontsize={size}")
        return _do

    def open_config(icon, item):
        threading.Thread(target=on_open_config, daemon=True).start()

    def quit_app(icon, item):
        icon.stop()
        on_quit()

    menu = pystray.Menu(
        pystray.MenuItem('打开主界面', open_browser, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('主题', pystray.Menu(
            pystray.MenuItem('深色', set_theme('dark')),
            pystray.MenuItem('柔暗', set_theme('dim')),
            pystray.MenuItem('明亮', set_theme('light')),
            pystray.MenuItem('暖色', set_theme('solarized')),
        )),
        pystray.MenuItem('字体大小', pystray.Menu(
            pystray.MenuItem('小', set_fontsize('sm')),
            pystray.MenuItem('中', set_fontsize('md')),
            pystray.MenuItem('大', set_fontsize('lg')),
        )),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('重新配置 API', open_config),
        pystray.MenuItem('退出', quit_app),
    )

    icon = pystray.Icon(
        name='ProfessorOS',
        icon=_make_icon_image(),
        title='Professor OS',
        menu=menu,
    )

    icon.run()
