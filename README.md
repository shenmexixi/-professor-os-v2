# Professor OS v2

A self-contained desktop application for academic task management. Double-click the `.exe` to start — no Python installation required.

## Quick Start

1. Download `ProfessorOS.exe`
2. Double-click to run
3. On first launch, enter your Anthropic API Key in the configuration window
4. The browser opens automatically to `http://127.0.0.1:8000`

## Features

- **AI task parsing** — describe work in natural language; AI extracts tasks and assignments
- **Work items (支线)** — group tasks by project/paper/topic
- **People module** — track team members and their task assignments
- **Schedule view** — daily schedule with drag-and-drop
- **Workflow nodes** — visual sub-task breakdown per task
- **Meeting notes** — per-person meeting history
- **Themes & font size** — dark/dim/light/solarized, three font sizes
- **Undo** — pop last confirmed change

## Configuration

Config is stored at `%APPDATA%\ProfessorOS\config.json`:

```json
{
  "api_key": "sk-ant-..."
}
```

Database is stored at `%APPDATA%\ProfessorOS\data\professor.db`.

## Data Export / Import

Export one person's tasks to a portable JSON file:

```bash
python tools/export_person.py "张三" --output export_zhangsan.json
```

Import into a fresh instance:

```bash
python tools/import_data.py export_zhangsan.json
```

## Multi-Machine Deployment

To run on a new machine with existing data:

1. Copy `%APPDATA%\ProfessorOS\data\professor.db` from the old machine
2. Place it at the same path on the new machine
3. Run `ProfessorOS.exe` — it will detect the existing database and skip initialization

Or use export/import to selectively migrate individual persons' data.

## Development

```bash
pip install -r requirements.txt
python main.py
```

Build the `.exe`:

```bash
pip install pyinstaller
pyinstaller professor_os.spec
# Output: dist/ProfessorOS.exe
```

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the three-phase development plan.
