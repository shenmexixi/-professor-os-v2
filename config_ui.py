import tkinter as tk
from tkinter import messagebox
from config import config


RELAY_PRESETS = [
    ("Custom / Official", ""),
    ("Rightcode", "https://api.rightcode.cn/v1"),
    ("Mirrorstage", "https://api.mirrorstage.com"),
]


class ConfigWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Professor OS - First Run Setup")
        self.root.geometry("500x380")
        self.root.resizable(False, False)
        self.show_key = False
        self.skipped = False
        self._build_ui()

    def _build_ui(self):
        tk.Label(self.root, text="Welcome to Professor OS",
                 font=("Arial", 14, "bold")).pack(pady=(20, 2))
        tk.Label(self.root, text="Configure your Claude API connection",
                 font=("Arial", 9), fg="#888888").pack(pady=(0, 14))

        form = tk.Frame(self.root)
        form.pack(padx=30, fill=tk.X)
        form.columnconfigure(0, weight=1)

        # API Key
        tk.Label(form, text="API Key *", font=("Arial", 9),
                 anchor="w").grid(row=0, column=0, sticky="w", pady=(0, 2))
        key_row = tk.Frame(form)
        key_row.grid(row=1, column=0, sticky="ew", pady=(0, 12))
        key_row.columnconfigure(0, weight=1)

        self.entry_key = tk.Entry(key_row, show="*", font=("Consolas", 10))
        self.entry_key.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        if config.api_key:
            self.entry_key.insert(0, config.api_key)
        tk.Button(key_row, text="Show", width=5,
                  command=self._toggle_visibility).grid(row=0, column=1)

        # Relay preset selector
        tk.Label(form, text="API Relay", font=("Arial", 9),
                 anchor="w").grid(row=2, column=0, sticky="w", pady=(0, 2))
        preset_row = tk.Frame(form)
        preset_row.grid(row=3, column=0, sticky="ew", pady=(0, 6))

        self._preset_var = tk.StringVar(value=RELAY_PRESETS[0][0])
        for label, url in RELAY_PRESETS:
            tk.Radiobutton(
                preset_row, text=label, variable=self._preset_var,
                value=label, command=self._on_preset,
                font=("Arial", 9)
            ).pack(side=tk.LEFT, padx=(0, 14))

        # Base URL (manual entry)
        self.entry_url = tk.Entry(form, font=("Consolas", 9), fg="#555555")
        self.entry_url.grid(row=4, column=0, sticky="ew", pady=(0, 4))
        # Pre-fill: use saved config if exists, otherwise default to Mirrorstage
        saved_url = config.base_url
        if not saved_url:
            saved_url = "https://api.mirrorstages.com/anthropic"
        self.entry_url.insert(0, saved_url)
        self._select_preset_for_url(saved_url)
        tk.Label(form, text="Leave blank to use official api.anthropic.com",
                 font=("Arial", 8), fg="#aaaaaa", anchor="w").grid(
            row=5, column=0, sticky="w", pady=(0, 10))

        # Model
        tk.Label(form, text="Model", font=("Arial", 9),
                 anchor="w").grid(row=6, column=0, sticky="w", pady=(0, 2))
        self.entry_model = tk.Entry(form, font=("Consolas", 10))
        self.entry_model.grid(row=7, column=0, sticky="ew", pady=(0, 4))
        self.entry_model.insert(0, config.model)

        # Buttons
        btn_row = tk.Frame(self.root)
        btn_row.pack(pady=18)

        tk.Button(btn_row, text="Save & Launch",
                  command=self._save,
                  width=18, height=2,
                  font=("Arial", 10, "bold")).pack(side=tk.LEFT, padx=(0, 10))

        tk.Button(btn_row, text="Skip (no AI)",
                  command=self._skip,
                  width=12, height=2,
                  font=("Arial", 10),
                  fg="#888888").pack(side=tk.LEFT)

        tk.Label(self.root,
                 text="Config: %APPDATA%\\ProfessorOS\\config.json",
                 font=("Arial", 7), fg="#aaaaaa").pack()

        self.root.bind("<Return>", lambda _: self._save())

    def _on_preset(self):
        label = self._preset_var.get()
        for lbl, url in RELAY_PRESETS:
            if lbl == label:
                self.entry_url.delete(0, tk.END)
                self.entry_url.insert(0, url)
                break

    def _select_preset_for_url(self, url):
        for label, preset_url in RELAY_PRESETS:
            if url == preset_url:
                self._preset_var.set(label)
                return
        self._preset_var.set(RELAY_PRESETS[0][0])  # Custom

    def _toggle_visibility(self):
        self.show_key = not self.show_key
        self.entry_key.config(show="" if self.show_key else "*")

    def _save(self):
        api_key = self.entry_key.get().strip()
        if not api_key:
            messagebox.showerror("Error", "API Key is required.", parent=self.root)
            return
        config.api_key = api_key
        config.base_url = self.entry_url.get().strip()
        model = self.entry_model.get().strip()
        config.model = model if model else "claude-sonnet-4-6"
        self.root.destroy()

    def _skip(self):
        self.skipped = True
        self.root.destroy()

    def run(self):
        self.root.mainloop()
        return self.skipped


def show_config_window() -> bool:
    """Show first-run configuration window.
    Returns True if user clicked Skip, False if saved normally."""
    window = ConfigWindow()
    return window.run()
