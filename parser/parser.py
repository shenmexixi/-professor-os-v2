# professor-os/parser/parser.py
from .llm.base import LLMProvider, ParsedResult


def parse_input(text: str, db_context: dict, provider: LLMProvider, onboarding: bool = False) -> ParsedResult:
    """Parse natural language text into structured changes using the given LLM provider."""
    return provider.parse_input(text, db_context, onboarding=onboarding)
