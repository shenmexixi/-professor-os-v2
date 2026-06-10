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
