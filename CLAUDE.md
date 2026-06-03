# Professor OS v2 — Development Rules

## Version Role

This is the **production repo**. It packages to `dist/ProfessorOS.exe` for distribution.

- Test/experimental repo: `D:\Projects\School manager\professor-os`
- Production repo (this): `D:\Projects\School manager\professor-os-v2`

## When to Push to GitHub

**Ask before pushing.** Do not push automatically. Push when:
- A bug fix is ready and confirmed working
- A feature milestone is complete
- User explicitly asks to push

Command: `git push origin master`

## When to Rebuild the .exe

**Ask before rebuilding.** Do not rebuild automatically. Rebuild when:
- User says "打包" / "build" / "rebuild" / "generate exe"
- A feature is complete and ready for distribution
- User explicitly asks for a new .exe

Command (run from repo root):
```bash
pyinstaller professor_os.spec
```
Output: `dist/ProfessorOS.exe`

## Feature Development Workflow

1. **Bug fixes** → fix directly in this repo, ask if user wants to push/rebuild
2. **New features** → prototype in test repo (`professor-os`) first, port here when stable
3. **Never** experiment with untested architecture directly in this repo

## Commit Style

```bash
git add <specific files>   # never git add .
git commit -m "fix: ..." / "feat: ..." / "refactor: ..."
```

## API Configuration

Config stored at `%APPDATA%\ProfessorOS\config.json`:
```json
{
  "api_key": "...",
  "base_url": "...",
  "model": "claude-sonnet-4-6"
}
```

Supported relay presets in config UI:
- **Rightcode**: `https://api.rightcode.cn/v1`
- **Mirrorstage**: `https://api.mirrorstage.com`
- Custom: user enters manually
- Official: leave blank (api.anthropic.com)
