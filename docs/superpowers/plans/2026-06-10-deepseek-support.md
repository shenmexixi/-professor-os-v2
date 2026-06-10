# DeepSeek Provider Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DeepSeek as a selectable LLM provider alongside Claude, with UI in the config window to switch between them.

**Architecture:** New `DeepSeekProvider` in `parser/llm/deepseek.py` uses the `openai` SDK (DeepSeek is OpenAI-compatible). `config.py` gains a `provider` attribute (`"claude"` | `"deepseek"`). `config_ui.py` gains provider radio buttons that swap the Base URL / Model defaults. `web/app.py` instantiates the right provider at startup.

**Tech Stack:** Python `openai` SDK (already installed, v1.109.1), existing `anthropic` SDK for Claude path, tkinter for config UI.

---

## File Structure

| File | Change |
|------|--------|
| `parser/llm/deepseek.py` | **Create** — `DeepSeekProvider(LLMProvider)` using `openai.OpenAI` |
| `parser/llm/claude.py` | Extract `_repair_json` → `parser/llm/utils.py` (shared) |
| `parser/llm/utils.py` | **Create** — shared `_repair_json` + `_extract_json_obj` helpers |
| `config.py` | Add `provider` property; update `LLM_PROVIDER` proxy |
| `config_ui.py` | Add provider radio buttons; swap Base URL/Model defaults on toggle |
| `web/app.py` | Instantiate `DeepSeekProvider` when `config.LLM_PROVIDER == "deepseek"` |

---

## Task 1: Extract shared JSON utilities

**Files:**
- Create: `parser/llm/utils.py`
- Modify: `parser/llm/claude.py`

- [ ] **Step 1: Create `parser/llm/utils.py` with shared helpers**

```python
# parser/llm/utils.py
import re
import json


def repair_json(raw: str) -> str:
    """Best-effort repair of common LLM JSON mistakes before parsing."""
    raw = raw.replace('，', ',').replace('：', ':').replace('\u201c', '"').replace('\u201d', '"')
    raw = raw.replace('；', ';').replace('。', '.').replace('\u3001', ',')
    raw = re.sub(r'"add_work item"', '"add_work_item"', raw)
    raw = re.sub(r'"update_work item"', '"update_work_item"', raw)
    raw = re.sub(r',\s*([\]}])', r'\1', raw)
    raw = re.sub(r'""([^"]+)""', r'"\1"', raw)
    raw = re.sub(r'"",', '",', raw)
    raw = re.sub(r'""([}\]])', r'"\1', raw)
    raw = re.sub(r'""(\s*[}\]])', r'"\1', raw)
    raw = re.sub(r'(\[\s*)\n(\s*"action")', r'\1\n{\2', raw)
    raw = re.sub(r'(,\s*)\n(\s*"action")', r'\1\n{\2', raw)
    return raw


def extract_json(raw: str) -> dict:
    """Strip markdown fences, find outermost JSON object, repair, and parse."""
    json_match = re.search(r'```(?:json)?\s*\n(.*?)\n```', raw, re.DOTALL)
    if json_match:
        raw = json_match.group(1).strip()
    obj_match = re.search(r'\{.*\}', raw, re.DOTALL)
    if obj_match:
        raw = obj_match.group(0)
    raw = repair_json(raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"LLM returned invalid JSON: {raw[:200]}") from e
```

- [ ] **Step 2: Update `parser/llm/claude.py` to import from utils**

Replace the `_repair_json` definition and its inline usage with imports from utils. The full updated file:

```python
# parser/llm/claude.py
import re
from datetime import date
import anthropic
from .base import LLMProvider, ParsedResult, ParsedChange
from .utils import repair_json, extract_json
from parser.prompts import SYSTEM_PROMPT, build_user_prompt
import config


class ClaudeProvider(LLMProvider):
    def __init__(self):
        self._client = None  # lazy — built on first use so API key is available

    def _get_client(self):
        if self._client is not None:
            return self._client
        import httpx
        http_client = httpx.Client(http2=False, trust_env=True)
        kwargs = {
            "api_key": config.ANTHROPIC_API_KEY,
            "http_client": http_client,
        }
        if config.ANTHROPIC_BASE_URL:
            kwargs["base_url"] = config.ANTHROPIC_BASE_URL
        self._client = anthropic.Anthropic(**kwargs)
        return self._client

    def parse_input(self, text: str, db_context: dict, onboarding: bool = False) -> ParsedResult:
        from parser.prompts import build_onboarding_prompt
        if onboarding:
            system, user = build_onboarding_prompt(text)
        else:
            system = SYSTEM_PROMPT.replace("{today}", date.today().isoformat())
            user = build_user_prompt(text, db_context)

        last_err = None
        for attempt in range(3):
            try:
                message = self._get_client().messages.create(
                    model=config.ANTHROPIC_MODEL,
                    max_tokens=1024,
                    system=system,
                    messages=[{"role": "user", "content": user}],
                )
                break
            except anthropic.APIStatusError as e:
                if e.status_code == 503 and attempt < 2:
                    import time
                    time.sleep(2 ** attempt)
                    last_err = e
                    continue
                raise RuntimeError(f"LLM API call failed: {e}") from e
            except anthropic.APIError as e:
                raise RuntimeError(f"LLM API call failed: {e}") from e
        else:
            raise RuntimeError(f"LLM API call failed after 3 attempts: {last_err}")

        if not message.content or message.content[0].type != "text":
            raise RuntimeError("LLM returned unexpected response format")

        payload = extract_json(message.content[0].text.strip())
        changes = [ParsedChange(**c) for c in payload.get("changes", [])
                   if c.get("action") != "add_stakeholder_note"]
        return ParsedResult(
            changes=changes,
            pending_questions=payload.get("pending_questions", []),
        )

    def parse_raw(self, system: str, user: str) -> dict:
        message = self._get_client().messages.create(
            model=config.ANTHROPIC_MODEL,
            max_tokens=2048,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return extract_json(message.content[0].text.strip())
```

- [ ] **Step 3: Verify the app still starts**

```bash
cd "D:\Projects\School manager\professor-os-v2"
python -c "from parser.llm.claude import ClaudeProvider; print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
cd "D:\Projects\School manager\professor-os-v2"
git add parser/llm/utils.py parser/llm/claude.py
git commit -m "refactor: extract shared JSON utils for LLM providers"
```

---

## Task 2: Add `DeepSeekProvider`

**Files:**
- Create: `parser/llm/deepseek.py`

- [ ] **Step 1: Create `parser/llm/deepseek.py`**

```python
# parser/llm/deepseek.py
from datetime import date
from openai import OpenAI, APIStatusError, APIError
from .base import LLMProvider, ParsedResult, ParsedChange
from .utils import extract_json
from parser.prompts import SYSTEM_PROMPT, build_user_prompt
import config


class DeepSeekProvider(LLMProvider):
    def __init__(self):
        self._client = None  # lazy init

    def _get_client(self):
        if self._client is not None:
            return self._client
        base_url = config.ANTHROPIC_BASE_URL or "https://api.deepseek.com"
        self._client = OpenAI(
            api_key=config.ANTHROPIC_API_KEY,
            base_url=base_url,
        )
        return self._client

    def parse_input(self, text: str, db_context: dict, onboarding: bool = False) -> ParsedResult:
        from parser.prompts import build_onboarding_prompt
        if onboarding:
            system, user = build_onboarding_prompt(text)
        else:
            system = SYSTEM_PROMPT.replace("{today}", date.today().isoformat())
            user = build_user_prompt(text, db_context)

        last_err = None
        for attempt in range(3):
            try:
                response = self._get_client().chat.completions.create(
                    model=config.ANTHROPIC_MODEL,
                    max_tokens=1024,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                )
                break
            except APIStatusError as e:
                if e.status_code == 503 and attempt < 2:
                    import time
                    time.sleep(2 ** attempt)
                    last_err = e
                    continue
                raise RuntimeError(f"LLM API call failed: {e}") from e
            except APIError as e:
                raise RuntimeError(f"LLM API call failed: {e}") from e
        else:
            raise RuntimeError(f"LLM API call failed after 3 attempts: {last_err}")

        raw = response.choices[0].message.content
        if not raw:
            raise RuntimeError("LLM returned empty response")

        payload = extract_json(raw.strip())
        changes = [ParsedChange(**c) for c in payload.get("changes", [])
                   if c.get("action") != "add_stakeholder_note"]
        return ParsedResult(
            changes=changes,
            pending_questions=payload.get("pending_questions", []),
        )

    def parse_raw(self, system: str, user: str) -> dict:
        response = self._get_client().chat.completions.create(
            model=config.ANTHROPIC_MODEL,
            max_tokens=2048,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        raw = response.choices[0].message.content
        if not raw:
            raise RuntimeError("LLM returned empty response")
        return extract_json(raw.strip())
```

- [ ] **Step 2: Verify import**

```bash
cd "D:\Projects\School manager\professor-os-v2"
python -c "from parser.llm.deepseek import DeepSeekProvider; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Quick smoke test with the real key**

```bash
cd "D:\Projects\School manager\professor-os-v2"
python - <<'EOF'
import os, sys
# Manually inject config so we don't need full app startup
sys.path.insert(0, '.')
# Patch config attributes directly for test
import config as cfg_mod
cfg_mod._config_obj._config['api_key'] = 'sk-321653c89b8149758a2262dbdd886e5a'
cfg_mod._config_obj._config['base_url'] = 'https://api.deepseek.com'
cfg_mod._config_obj._config['model'] = 'deepseek-chat'
cfg_mod._config_obj._config['provider'] = 'deepseek'

from parser.llm.deepseek import DeepSeekProvider
p = DeepSeekProvider()
result = p.parse_input("新建一个论文支线：纳米材料综述", db_context={"people": [], "work_items": []})
print("changes:", len(result.changes))
print("first action:", result.changes[0].action if result.changes else "none")
print("PASS")
EOF
```

Expected: prints `PASS` with at least one change of action `add_work_item`.

- [ ] **Step 4: Commit**

```bash
cd "D:\Projects\School manager\professor-os-v2"
git add parser/llm/deepseek.py
git commit -m "feat: add DeepSeekProvider using openai SDK"
```

---

## Task 3: Add `provider` to Config

**Files:**
- Modify: `config.py`

- [ ] **Step 1: Add `provider` property to `Config` class and update `LLM_PROVIDER` proxy**

Replace the `Config` class body and the proxy in `config.py`. Full updated file:

```python
import os
import sys
import json
from pathlib import Path


class Config:
    def __init__(self):
        self.config_dir = Path(os.getenv('APPDATA')) / 'ProfessorOS'
        self.config_file = self.config_dir / 'config.json'
        self.data_dir = self.config_dir / 'data'
        self.db_path = self.data_dir / 'professor.db'

        self._ensure_dirs()
        self._config = self._load_config()

    def _ensure_dirs(self):
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _load_config(self):
        if self.config_file.exists():
            with open(self.config_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}

    def save(self):
        with open(self.config_file, 'w', encoding='utf-8') as f:
            json.dump(self._config, f, indent=2, ensure_ascii=False)

    @property
    def api_key(self):
        return self._config.get('api_key', '')

    @api_key.setter
    def api_key(self, value):
        self._config['api_key'] = value
        self.save()

    @property
    def base_url(self):
        return self._config.get('base_url', '')

    @base_url.setter
    def base_url(self, value):
        self._config['base_url'] = value
        self.save()

    @property
    def model(self):
        return self._config.get('model', 'claude-sonnet-4-6')

    @model.setter
    def model(self, value):
        self._config['model'] = value
        self.save()

    @property
    def provider(self):
        return self._config.get('provider', 'claude')

    @provider.setter
    def provider(self, value):
        self._config['provider'] = value
        self.save()

    @property
    def is_configured(self):
        return bool(self.api_key)


config = Config()


# ── Module-level proxy so `import config; config.ANTHROPIC_API_KEY` works ──
import types

class _ConfigModuleProxy(types.ModuleType):
    """Wraps the config module so module-level attribute access hits Config."""

    def __init__(self, wrapped):
        super().__init__(__name__)
        self.__dict__.update(wrapped.__dict__)
        self._config_obj = wrapped.config

    @property
    def ANTHROPIC_API_KEY(self):
        return self._config_obj.api_key

    @property
    def ANTHROPIC_BASE_URL(self):
        return self._config_obj.base_url

    @property
    def ANTHROPIC_MODEL(self):
        return self._config_obj.model

    @property
    def DB_PATH(self):
        return self._config_obj.db_path

    @property
    def SNAPSHOTS_DIR(self):
        return self._config_obj.data_dir / 'snapshots'

    @property
    def LLM_PROVIDER(self):
        return self._config_obj.provider


sys.modules[__name__] = _ConfigModuleProxy(sys.modules[__name__])
```

- [ ] **Step 2: Verify config loads correctly**

```bash
cd "D:\Projects\School manager\professor-os-v2"
python -c "import config; print('provider:', config.LLM_PROVIDER); print('OK')"
```

Expected: `provider: claude` (default) then `OK`.

- [ ] **Step 3: Commit**

```bash
cd "D:\Projects\School manager\professor-os-v2"
git add config.py
git commit -m "feat: add provider config property (claude|deepseek)"
```

---

## Task 4: Wire provider in `web/app.py`

**Files:**
- Modify: `web/app.py` (lines 27–35)

- [ ] **Step 1: Update provider instantiation in `create_app`**

Replace the provider selection block (lines 27–35 in `web/app.py`):

```python
    # Provider is set here; can be overridden in tests
    try:
        if config.LLM_PROVIDER == "deepseek":
            from parser.llm.deepseek import DeepSeekProvider
            app.state.provider = DeepSeekProvider()
        else:
            from parser.llm.claude import ClaudeProvider
            app.state.provider = ClaudeProvider()
    except Exception:
        app.state.provider = None
```

- [ ] **Step 2: Verify app imports cleanly**

```bash
cd "D:\Projects\School manager\professor-os-v2"
python -c "from web.app import app; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd "D:\Projects\School manager\professor-os-v2"
git add web/app.py
git commit -m "feat: wire DeepSeekProvider in app based on config.provider"
```

---

## Task 5: Add provider selector to config UI

**Files:**
- Modify: `config_ui.py`

This is the most substantial UI change. The config window gains a provider row at the top. When "DeepSeek" is selected, the relay presets are hidden and the URL/model fields pre-fill with DeepSeek defaults. When "Claude" is selected, relay presets return and Claude defaults apply.

- [ ] **Step 1: Replace `config_ui.py` with updated version**

```python
import tkinter as tk
from tkinter import messagebox
from config import config


RELAY_PRESETS = [
    ("Custom / Official", ""),
    ("Rightcode", "https://api.rightcode.cn/v1"),
    ("Mirrorstage", "https://api.mirrorstages.com/anthropic"),
]

PROVIDER_DEFAULTS = {
    "claude": {
        "base_url": "https://api.mirrorstages.com/anthropic",
        "model": "claude-sonnet-4-6",
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-chat",
    },
}


class ConfigWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Professor OS - Configuration")
        self.root.geometry("500x420")
        self.root.resizable(False, False)
        self.show_key = False
        self.skipped = False
        self._build_ui()

    def _build_ui(self):
        tk.Label(self.root, text="Welcome to Professor OS",
                 font=("Arial", 14, "bold")).pack(pady=(20, 2))
        tk.Label(self.root, text="Configure your LLM connection",
                 font=("Arial", 9), fg="#888888").pack(pady=(0, 14))

        form = tk.Frame(self.root)
        form.pack(padx=30, fill=tk.X)
        form.columnconfigure(0, weight=1)

        # Provider selector
        tk.Label(form, text="Provider", font=("Arial", 9),
                 anchor="w").grid(row=0, column=0, sticky="w", pady=(0, 2))
        provider_row = tk.Frame(form)
        provider_row.grid(row=1, column=0, sticky="ew", pady=(0, 12))

        self._provider_var = tk.StringVar(value=config.provider or "claude")
        tk.Radiobutton(
            provider_row, text="Claude (Anthropic)", variable=self._provider_var,
            value="claude", command=self._on_provider_change,
            font=("Arial", 9)
        ).pack(side=tk.LEFT, padx=(0, 20))
        tk.Radiobutton(
            provider_row, text="DeepSeek", variable=self._provider_var,
            value="deepseek", command=self._on_provider_change,
            font=("Arial", 9)
        ).pack(side=tk.LEFT)

        # API Key
        tk.Label(form, text="API Key *", font=("Arial", 9),
                 anchor="w").grid(row=2, column=0, sticky="w", pady=(0, 2))
        key_row = tk.Frame(form)
        key_row.grid(row=3, column=0, sticky="ew", pady=(0, 12))
        key_row.columnconfigure(0, weight=1)

        self.entry_key = tk.Entry(key_row, show="*", font=("Consolas", 10))
        self.entry_key.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        if config.api_key:
            self.entry_key.insert(0, config.api_key)
        tk.Button(key_row, text="Show", width=5,
                  command=self._toggle_visibility).grid(row=0, column=1)

        # Relay preset selector (Claude only)
        self._relay_label = tk.Label(form, text="API Relay", font=("Arial", 9), anchor="w")
        self._relay_label.grid(row=4, column=0, sticky="w", pady=(0, 2))
        self._preset_row = tk.Frame(form)
        self._preset_row.grid(row=5, column=0, sticky="ew", pady=(0, 6))

        self._preset_var = tk.StringVar(value=RELAY_PRESETS[0][0])
        for label, url in RELAY_PRESETS:
            tk.Radiobutton(
                self._preset_row, text=label, variable=self._preset_var,
                value=label, command=self._on_preset,
                font=("Arial", 9)
            ).pack(side=tk.LEFT, padx=(0, 14))

        # Base URL
        self._url_label = tk.Label(form, text="Base URL", font=("Arial", 9), anchor="w")
        self._url_label.grid(row=6, column=0, sticky="w", pady=(0, 2))
        self.entry_url = tk.Entry(form, font=("Consolas", 9), fg="#555555")
        self.entry_url.grid(row=7, column=0, sticky="ew", pady=(0, 4))
        self._url_hint = tk.Label(form, text="Leave blank to use official api.anthropic.com",
                                  font=("Arial", 8), fg="#aaaaaa", anchor="w")
        self._url_hint.grid(row=8, column=0, sticky="w", pady=(0, 10))

        # Model
        tk.Label(form, text="Model", font=("Arial", 9),
                 anchor="w").grid(row=9, column=0, sticky="w", pady=(0, 2))
        self.entry_model = tk.Entry(form, font=("Consolas", 10))
        self.entry_model.grid(row=10, column=0, sticky="ew", pady=(0, 4))

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

        # Populate fields based on saved config or defaults
        self._populate_url_model()

    def _populate_url_model(self):
        """Fill URL and model fields from saved config or provider defaults."""
        provider = self._provider_var.get()
        defaults = PROVIDER_DEFAULTS[provider]

        self.entry_url.delete(0, tk.END)
        self.entry_model.delete(0, tk.END)

        saved_url = config.base_url
        saved_model = config.model

        # Use saved values if they exist and provider matches saved provider
        if config.provider == provider and saved_url:
            self.entry_url.insert(0, saved_url)
        else:
            self.entry_url.insert(0, defaults["base_url"])

        if config.provider == provider and saved_model:
            self.entry_model.insert(0, saved_model)
        else:
            self.entry_model.insert(0, defaults["model"])

        if provider == "claude":
            self._select_preset_for_url(self.entry_url.get())
        self._update_relay_visibility()

    def _on_provider_change(self):
        provider = self._provider_var.get()
        defaults = PROVIDER_DEFAULTS[provider]
        self.entry_url.delete(0, tk.END)
        self.entry_url.insert(0, defaults["base_url"])
        self.entry_model.delete(0, tk.END)
        self.entry_model.insert(0, defaults["model"])
        if provider == "claude":
            self._select_preset_for_url(defaults["base_url"])
        self._update_relay_visibility()

    def _update_relay_visibility(self):
        is_claude = self._provider_var.get() == "claude"
        state = tk.NORMAL if is_claude else tk.DISABLED
        # Show/hide relay row widgets
        for widget in self._preset_row.winfo_children():
            widget.config(state=state)
        label_fg = "#000000" if is_claude else "#aaaaaa"
        self._relay_label.config(fg=label_fg)
        hint_text = ("Leave blank to use official api.anthropic.com"
                     if is_claude else "DeepSeek base URL (change only if using a proxy)")
        self._url_hint.config(text=hint_text)

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
        config.provider = self._provider_var.get()
        config.base_url = self.entry_url.get().strip()
        model = self.entry_model.get().strip()
        provider = self._provider_var.get()
        default_model = PROVIDER_DEFAULTS[provider]["model"]
        config.model = model if model else default_model
        self.root.destroy()

    def _skip(self):
        self.skipped = True
        self.root.destroy()

    def run(self):
        self.root.mainloop()
        return self.skipped


def show_config_window() -> bool:
    """Show configuration window.
    Returns True if user clicked Skip, False if saved normally."""
    window = ConfigWindow()
    return window.run()
```

- [ ] **Step 2: Verify config_ui imports cleanly**

```bash
cd "D:\Projects\School manager\professor-os-v2"
python -c "from config_ui import ConfigWindow; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd "D:\Projects\School manager\professor-os-v2"
git add config_ui.py
git commit -m "feat: add provider selector (Claude/DeepSeek) to config window"
```

---

## Task 6: Reset provider client on reconfig

**Files:**
- Modify: `main.py` (lines 67–76, `reopen_config` function)

When the user changes provider via the tray "Reconfig" option, the cached provider client must be invalidated so the new provider/key takes effect without restart.

- [ ] **Step 1: Update `reopen_config` in `main.py`**

Replace the `reopen_config` function:

```python
def reopen_config():
    """Re-open config window (called from tray menu)."""
    show_config_window()
    # Rebuild provider with new config
    try:
        from web.app import app as _app
        if config.LLM_PROVIDER == "deepseek":
            from parser.llm.deepseek import DeepSeekProvider
            _app.state.provider = DeepSeekProvider()
        else:
            from parser.llm.claude import ClaudeProvider
            _app.state.provider = ClaudeProvider()
    except Exception:
        pass
```

- [ ] **Step 2: Verify main.py imports cleanly**

```bash
cd "D:\Projects\School manager\professor-os-v2"
python -c "import main; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
cd "D:\Projects\School manager\professor-os-v2"
git add main.py
git commit -m "feat: rebuild provider on reconfig to pick up provider change"
```

---

## Task 7: End-to-end verification

- [ ] **Step 1: Start the app with DeepSeek config and parse a sentence**

Manually set config to DeepSeek (edit `%APPDATA%\ProfessorOS\config.json`):
```json
{
  "api_key": "sk-321653c89b8149758a2262dbdd886e5a",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "provider": "deepseek"
}
```

Then run:
```bash
cd "D:\Projects\School manager\professor-os-v2"
python main.py
```

In the browser, type: `新建一个项目支线：纳米材料光热研究`

Expected: A work item "纳米材料光热研究" appears in the confirm panel.

- [ ] **Step 2: Switch back to Claude via tray reconfig**

Click tray → Reconfig → select Claude, enter Claude key → Save & Launch.

Parse another sentence and verify Claude responds.

- [ ] **Step 3: Push to GitHub**

```bash
cd "D:\Projects\School manager\professor-os-v2"
git push origin master
```
