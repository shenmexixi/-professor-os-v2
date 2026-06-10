# parser/llm/claude.py
from datetime import date
import anthropic
from .base import LLMProvider, ParsedResult, ParsedChange
from .utils import extract_json
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
