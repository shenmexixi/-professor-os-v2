"""
System tray icon for Professor OS.
Menu: open browser, themes, font sizes, reconfig API, quit.
Theme/font changes are pushed to the open browser page via SSE (no new window).
"""
import threading
import webbrowser
from PIL import Image, ImageDraw


def _make_icon_image():
    """
    Rounded square, dark bg, green left-accent bar, white 'P' monogram.
    """
    S = 128
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=28, fill=(22, 27, 34, 255))
    d.rounded_rectangle([0, 0, 10, S - 1], radius=4, fill=(63, 185, 80, 255))

    white = (230, 237, 243, 255)
    inner = (22, 27, 34, 255)
    px, py = 28, 24
    sw, ph, bh = 10, 80, 38

    d.rectangle([px, py, px + sw, py + ph], fill=white)
    d.ellipse([px + sw - 4, py, px + sw + 72, py + bh * 2], fill=white)
    d.ellipse([px + sw + 6, py + 8, px + sw + 62, py + bh * 2 - 8], fill=inner)

    return img


# Track current prefs in memory so menu can show checkmarks
_current_theme = 'dark'
_current_fontsize = 'md'


def run_tray(on_quit, on_open_config, server_url="http://127.0.0.1:8000"):
    """Start the system tray icon (blocking, call from main thread)."""
    import pystray

    def _post_pref(**kwargs):
        """POST to local server to push pref change via SSE."""
        try:
            import urllib.request, json
            data = json.dumps(kwargs).encode()
            req = urllib.request.Request(
                f"{server_url}/api/tray/pref",
                data=data,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass

    def open_browser(icon=None, item=None):
        webbrowser.open(server_url)

    def set_theme(theme):
        def _do(icon, item):
            global _current_theme
            _current_theme = theme
            _post_pref(theme=theme)
        return _do

    def set_fontsize(size):
        def _do(icon, item):
            global _current_fontsize
            _current_fontsize = size
            _post_pref(font_size=size)
        return _do

    def open_config(icon, item):
        threading.Thread(target=on_open_config, daemon=True).start()

    def quit_app(icon, item):
        icon.stop()
        on_quit()

    THEME_LABELS = {
        'dark': '深色', 'dim': '柔暗', 'light': '明亮', 'solarized': '暖色',
    }
    FONT_LABELS = {'sm': '小', 'md': '中', 'lg': '大'}

    def theme_item(key):
        def checked(item):
            return _current_theme == key
        return pystray.MenuItem(
            THEME_LABELS[key], set_theme(key), checked=checked, radio=True
        )

    def font_item(key):
        def checked(item):
            return _current_fontsize == key
        return pystray.MenuItem(
            FONT_LABELS[key], set_fontsize(key), checked=checked, radio=True
        )

    menu = pystray.Menu(
        pystray.MenuItem('打开主界面', open_browser, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('主题', pystray.Menu(
            theme_item('dark'),
            theme_item('dim'),
            theme_item('light'),
            theme_item('solarized'),
        )),
        pystray.MenuItem('字体大小', pystray.Menu(
            font_item('sm'),
            font_item('md'),
            font_item('lg'),
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
