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
