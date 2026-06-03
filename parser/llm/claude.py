# professor-os/parser/llm/claude.py
import json
import re
from datetime import date
import anthropic
from .base import LLMProvider, ParsedResult, ParsedChange
from parser.prompts import SYSTEM_PROMPT, build_user_prompt
import config


def _repair_json(raw: str) -> str:
    """Best-effort repair of common LLM JSON mistakes before parsing."""
    # Replace full-width / Chinese punctuation
    raw = raw.replace('，', ',').replace('：', ':').replace('"', '"').replace('"', '"')
    raw = raw.replace('；', ';').replace('。', '.').replace('\u3001', ',')

    # Fix action names with spaces: "add_work item" -> "add_work_item"
    raw = re.sub(r'"add_work item"', '"add_work_item"', raw)
    raw = re.sub(r'"update_work item"', '"update_work_item"', raw)

    # Remove trailing commas before ] or }
    raw = re.sub(r',\s*([\]}])', r'\1', raw)

    # Fix doubled quotes inside strings like ""title"" -> "title"  (naive fix)
    raw = re.sub(r'""([^"]+)""', r'"\1"', raw)

    # Fix trailing extra quote before comma/brace: "value"", -> "value",
    raw = re.sub(r'"",', '",', raw)
    raw = re.sub(r'""([}\]])', r'"\1', raw)
    raw = re.sub(r'""(\s*[}\]])', r'"\1', raw)

    # If "changes":[ is followed immediately by "action" without {, insert {
    # Pattern: [ possibly whitespace then "action" (missing opening brace)
    raw = re.sub(r'(\[\s*)\n(\s*"action")', r'\1\n{\2', raw)
    # Also handle comma-separated entries missing {
    raw = re.sub(r'(,\s*)\n(\s*"action")', r'\1\n{\2', raw)

    return raw


class ClaudeProvider(LLMProvider):
    def __init__(self):
        self._client = None  # lazy — built on first use so API key is available

    def _get_client(self):
        if self._client is not None:
            return self._client
        import httpx
        # trust_env=False prevents httpx from picking up Windows registry proxy (Clash on 7890),
        # which intercepts the connection and causes SSL EOF during TLS negotiation with mirrorstages.
        http_client = httpx.Client(http2=False, trust_env=False)
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
                    messages=[
                        {"role": "user", "content": user},
                    ],
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

        raw = message.content[0].text.strip()

        # Strip markdown code fences if present
        json_match = re.search(r'```(?:json)?\s*\n(.*?)\n```', raw, re.DOTALL)
        if json_match:
            raw = json_match.group(1).strip()

        # Find the outermost JSON object if extra text is present
        obj_match = re.search(r'\{.*\}', raw, re.DOTALL)
        if obj_match:
            raw = obj_match.group(0)

        raw = _repair_json(raw)

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"LLM returned invalid JSON: {raw[:200]}") from e

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
        raw = message.content[0].text.strip()
        raw = _repair_json(raw)
        obj = re.search(r'\{.*\}', raw, re.DOTALL)
        if obj:
            raw = obj.group(0)
        return json.loads(raw)
