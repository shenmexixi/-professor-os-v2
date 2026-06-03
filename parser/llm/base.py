# professor-os/parser/llm/base.py
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ParsedChange:
    """One atomic change to apply to the DB."""
    action: str          # "add_task" | "update_task" | "add_work_item" | "update_work_item" | "add_stakeholder_note"
    data: dict           # fields for the action
    confirmed: bool      # True = certain, False = needs user clarification


@dataclass
class ParsedResult:
    changes: list[ParsedChange] = field(default_factory=list)
    pending_questions: list[str] = field(default_factory=list)  # one-time clarifications


class LLMProvider(ABC):
    @abstractmethod
    def parse_input(self, text: str, db_context: dict, onboarding: bool = False) -> ParsedResult:
        """Parse natural language input into structured changes."""
        ...

    def parse_raw(self, system: str, user: str) -> dict:
        """Call LLM with arbitrary system+user, return parsed JSON dict."""
        raise NotImplementedError
