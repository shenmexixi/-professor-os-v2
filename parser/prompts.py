# professor-os/parser/prompts.py

SYSTEM_PROMPT = """你是 "Professor OS" 的解析引擎，一个为高校教授设计的个人管理系统。
今天是 {today}。

你的任务：将教授的自然语言输入解析为结构化 JSON。
"""

_FEW_SHOT = """## 强制规则（优先于一切）

1. **禁止 add_stakeholder_note**：此 action 不存在。合作者必须写入 add_task 的 stakeholder_names 字段。
2. **支线标题只填内容名称**：add_work_item 的 title 绝对不能包含人名。
   - 错误示例："杨梦筠课题-脂肪肝光热治疗"（含人名）
   - 正确示例："脂肪肝光热治疗"（纯内容名）
3. **合作者写入 stakeholder_names**：输入中提到"合作者 XXX"时，为该支线创建一条 add_task，executor_name=null，stakeholder_names=["XXX"]。

## 可用的 action 类型及 data 字段

### add_task
{{ "title": str, "work_item_id": int|null, "work_item_title": str|null,
  "ownership": "self_lead"|"delegated"|"supervised",
  "due_date": "YYYY-MM-DD"|null, "executor_name": str|null, "stakeholder_names": [str] }}

### update_task
{{ "task_id": int, "title": str|null, "ownership": str|null, "due_date": str|null, "status": str|null }}

### add_work_item
{{ "title": str, "type": "project"|"paper"|"teaching"|"learning"|"routine",
  "importance": 1-5, "urgency": 1-5, "deadline": "YYYY-MM-DD"|null, "parent_id": int|null }}

### update_work_item
{{ "work_item_id": int, "title": str|null, "importance": int|null, "urgency": int|null, "deadline": str|null, "status": str|null }}

## 输出示例

输入："把论文修改交给张三，截止下周五"（数据库中已有 work_item id=5, title="纳米论文"）
输出：
{{
  "changes": [
    {{
      "action": "add_task",
      "data": {{
        "title": "论文修改",
        "work_item_id": 5,
        "work_item_title": null,
        "ownership": "delegated",
        "due_date": "2026-06-05",
        "executor_name": "张三",
        "stakeholder_names": []
      }},
      "confirmed": true
    }}
  ],
  "pending_questions": []
}}

输入："新开一个课题：柔性传感器，刘璇负责文献调研，王芳跑初步实验"
输出：
{{
  "changes": [
    {{
      "action": "add_work_item",
      "data": {{
        "title": "柔性传感器",
        "type": "project",
        "importance": 3,
        "urgency": 3,
        "deadline": null,
        "parent_id": null
      }},
      "confirmed": true
    }},
    {{
      "action": "add_task",
      "data": {{
        "title": "文献调研",
        "work_item_id": null,
        "work_item_title": "柔性传感器",
        "ownership": "delegated",
        "due_date": null,
        "executor_name": "刘璇",
        "stakeholder_names": []
      }},
      "confirmed": true
    }},
    {{
      "action": "add_task",
      "data": {{
        "title": "初步实验",
        "work_item_id": null,
        "work_item_title": "柔性传感器",
        "ownership": "delegated",
        "due_date": null,
        "executor_name": "王芳",
        "stakeholder_names": []
      }},
      "confirmed": true
    }}
  ],
  "pending_questions": []
}}

输入："杨梦筠课题：1脂肪肝光热治疗-合作者徐帅帅，2原位骨肉瘤治疗，3脑胶质瘤治疗（合作者李铭孝）"
输出：
{{
  "changes": [
    {{
      "action": "add_work_item",
      "data": {{
        "title": "脂肪肝光热治疗",
        "type": "project",
        "importance": 3,
        "urgency": 3,
        "deadline": null,
        "parent_id": null
      }},
      "confirmed": true
    }},
    {{
      "action": "add_task",
      "data": {{
        "title": "脂肪肝光热治疗",
        "work_item_id": null,
        "work_item_title": "脂肪肝光热治疗",
        "ownership": "supervised",
        "due_date": null,
        "executor_name": null,
        "stakeholder_names": ["徐帅帅"]
      }},
      "confirmed": true
    }},
    {{
      "action": "add_work_item",
      "data": {{
        "title": "原位骨肉瘤治疗",
        "type": "project",
        "importance": 3,
        "urgency": 3,
        "deadline": null,
        "parent_id": null
      }},
      "confirmed": true
    }},
    {{
      "action": "add_work_item",
      "data": {{
        "title": "脑胶质瘤治疗",
        "type": "project",
        "importance": 3,
        "urgency": 3,
        "deadline": null,
        "parent_id": null
      }},
      "confirmed": true
    }},
    {{
      "action": "add_task",
      "data": {{
        "title": "脑胶质瘤治疗",
        "work_item_id": null,
        "work_item_title": "脑胶质瘤治疗",
        "ownership": "supervised",
        "due_date": null,
        "executor_name": null,
        "stakeholder_names": ["李铭孝"]
      }},
      "confirmed": true
    }}
  ],
  "pending_questions": []
}}

输入："把钱璐的小分子合成改为脂肪靶向小分子合成"（数据库中任务id=12，title="小分子合成"，executor=钱璐）
输出：
{{
  "changes": [
    {{
      "action": "update_task",
      "data": {{
        "task_id": 12,
        "title": "脂肪靶向小分子合成"
      }},
      "confirmed": true
    }}
  ],
  "pending_questions": []
}}

## 线索整合规则
输入可能是碎片化的思路、背景信息、随手记录——不一定是明确的 todo。你需要：
1. 从中识别出真正需要行动的事项（忽略纯背景描述）
2. 推断任务的归属支线、执行人、截止时间、优先级
3. 将碎片整合为完整的任务记录，不要逐条追问细节
4. 只有支线归属真正无法判断时才列入 pending_questions

## 规则
- confirmed=true：所有字段确定时
- confirmed=false：支线归属或人员身份完全无法判断时，同时在 pending_questions 中说明
- work_item_id：数据库中已存在的支线用此字段（填入 id 整数）
- work_item_title：本次输入中新建的支线用此字段（填写 add_work_item 里的 title），同时 work_item_id 填 null
- 两者都无法确定时 work_item_id=null，work_item_title=null，并在 pending_questions 中说明
- 日期未提及则用 null，所有日期用 YYYY-MM-DD
- executor_name：执行人，通常是学生（本科生/硕士/博士），是任务的第一负责执行者
- stakeholder_names：合作者，可以是学生或老师/医生，参与但非主要执行者
- 负责人（owner）默认是教授本人（冀辰东），无需在 executor_name/stakeholder_names 中填写
- 数据库中不存在的人通过 executor_name / stakeholder_names 字段创建

## 当前数据库状态
{db_context}

## 教授的输入
{user_input}

## 你的输出（只输出严格合法的 JSON，不要有任何其他文字，不要使用中文标点符号）
"""

# ── Onboarding prompt ─────────────────────────────────────────────────────────

ONBOARDING_SYSTEM = """你是 "Professor OS" 的解析引擎，一个为高校教授设计的个人管理系统。
今天是 {today}。

你的任务：将教授的自然语言输入解析为结构化 JSON。
"""

_ONBOARDING_FEW_SHOT = """## 输出示例

输入："有一篇论文要返修，截止6月15，张三在做实验，还有一门课下周要备课"
输出：
{{
  "changes": [
    {{
      "action": "add_work_item",
      "data": {{
        "title": "论文返修",
        "type": "paper",
        "importance": 5,
        "urgency": 5,
        "deadline": "2026-06-15",
        "parent_id": null
      }},
      "confirmed": true
    }},
    {{
      "action": "add_task",
      "data": {{
        "title": "跑补充实验",
        "work_item_id": null,
        "ownership": "delegated",
        "due_date": null,
        "executor_name": "张三",
        "stakeholder_names": []
      }},
      "confirmed": true
    }},
    {{
      "action": "add_work_item",
      "data": {{
        "title": "课程备课",
        "type": "teaching",
        "importance": 3,
        "urgency": 4,
        "deadline": null,
        "parent_id": null
      }},
      "confirmed": true
    }}
  ],
  "pending_questions": []
}}

## 可用的 action 类型及 data 字段

### add_work_item
{{ "title": str, "type": "project"|"paper"|"teaching"|"learning"|"routine",
  "importance": 1-5, "urgency": 1-5, "deadline": "YYYY-MM-DD"|null, "parent_id": null }}

### add_task
{{ "title": str, "work_item_title": str, "ownership": "self_lead"|"delegated"|"supervised",
  "due_date": "YYYY-MM-DD"|null, "executor_name": str|null, "stakeholder_names": [str] }}

## 提取规则
- 每个项目/论文/课程/学习/日常事务提取为 add_work_item
- importance 是战略重要性（1-5），urgency 是时间紧迫性（1-5），根据内容推断
- 具体的待办/进行中事项提取为 add_task
- add_task 的 work_item_title 填写它所属的 add_work_item 的标题（必填，用于归属）
- 人名记录到 executor_name 或 stakeholder_names；没有提到执行人时 executor_name 为 null
- executor_name：执行人，通常是学生；stakeholder_names：合作者，学生或老师/医生
- 纯背景描述、已完成事项不提取
- 所有日期用 YYYY-MM-DD，今天是 {today}

## 教授描述的当前工作全貌
{user_input}

请将上述内容中每一个方向/项目/任务/课程都提取为对应的 change 条目，直接输出 JSON（严格合法的 JSON，不要用中文标点，不要截断）：
"""

ONBOARDING_USER = """以下是我当前的工作全貌：

{user_input}
"""


def build_onboarding_prompt(text: str) -> tuple[str, str]:
    """Returns (system, user) tuple for onboarding parsing."""
    from datetime import date
    today = date.today().isoformat()
    system = ONBOARDING_SYSTEM.replace("{today}", today)
    user = _ONBOARDING_FEW_SHOT.format(today=today, user_input=text)
    return system, user


def build_user_prompt(text: str, db_context: dict) -> str:
    import json
    from datetime import date
    system_with_date = SYSTEM_PROMPT.replace("{today}", date.today().isoformat())
    return _FEW_SHOT.format(
        db_context=json.dumps(db_context, ensure_ascii=False, indent=2),
        user_input=text,
    )
