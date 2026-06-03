import tkinter as tk
from tkinter import messagebox
from config import config


class ConfigWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Professor OS — 首次配置")
        self.root.geometry("460x260")
        self.root.resizable(False, False)
        self.show_key = False
        self._build_ui()

    def _build_ui(self):
        # Title
        tk.Label(self.root, text="欢迎使用 Professor OS！",
                 font=("Arial", 14, "bold")).pack(pady=(24, 4))

        # API Key row
        tk.Label(self.root, text="请输入您的 Claude API Key：",
                 font=("Arial", 10)).pack()

        frame = tk.Frame(self.root)
        frame.pack(pady=14)

        self.entry = tk.Entry(frame, width=36, show="*",
                              font=("Consolas", 10))
        self.entry.pack(side=tk.LEFT, padx=(0, 6))

        self.toggle_btn = tk.Button(frame, text="👁",
                                    command=self._toggle_visibility,
                                    relief=tk.FLAT, padx=4)
        self.toggle_btn.pack(side=tk.LEFT)

        # Save button
        tk.Button(self.root, text="保存并启动",
                  command=self._save,
                  width=22, height=2,
                  font=("Arial", 11, "bold")).pack(pady=12)

        # Hint
        tk.Label(self.root,
                 text="配置保存至 %APPDATA%\\ProfessorOS\\config.json",
                 font=("Arial", 8), fg="#888888").pack(pady=(0, 8))

        # Allow Enter key to trigger save
        self.root.bind("<Return>", lambda _: self._save())

    def _toggle_visibility(self):
        self.show_key = not self.show_key
        self.entry.config(show="" if self.show_key else "*")

    def _save(self):
        api_key = self.entry.get().strip()
        if not api_key:
            messagebox.showerror("错误", "API Key 不能为空！", parent=self.root)
            return
        config.api_key = api_key
        self.root.destroy()

    def run(self):
        self.root.mainloop()


def show_config_window():
    """Show first-run configuration window; blocks until closed."""
    window = ConfigWindow()
    window.run()
