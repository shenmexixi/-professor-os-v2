# professor-os/parser/llm/ollama.py
from .base import LLMProvider, ParsedResult


class OllamaProvider(LLMProvider):
    def parse_input(self, text: str, db_context: dict) -> ParsedResult:
        raise ValueError(
            "OllamaProvider is not yet implemented. "
            "Set LLM_PROVIDER=claude in .env to use the default provider."
        )
