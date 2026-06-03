# web/api/workflow.py
import json
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel

router = APIRouter()


class NodeCreate(BaseModel):
    title: str
    time_estimate: int | None = None
    depends_on_id: int | None = None


class NodePatch(BaseModel):
    title: str | None = None
    status: str | None = None
    time_estimate: int | None = None
    position: int | None = None
    depends_on_id: int | None = None
    pos_x: float | None = None
    pos_y: float | None = None
    assignee: str | None = None
    due_date: str | None = None
    custom_tags: str | None = None  # JSON string, e.g. '["#写作","#论文"]'
    collapsed: int | None = None


class EdgeCreate(BaseModel):
    source_node_id: int
    target_node_id: int
    edge_type: str = "sequence"


def _node_dict(n: dict) -> dict:
    """Return node dict with custom_tags parsed to list."""
    d = dict(n)
    raw = d.get("custom_tags")
    try:
        d["custom_tags"] = json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        d["custom_tags"] = []
    return d


def _build_tree(nodes: list[dict]) -> list[dict]:
    """Convert flat list to nested tree by parent_node_id."""
    by_id = {n["id"]: {**_node_dict(n), "children": []} for n in nodes}
    roots = []
    for n in by_id.values():
        pid = n.get("parent_node_id")
        if pid is not None and pid in by_id:
            by_id[pid]["children"].append(n)
        else:
            roots.append(n)
    roots.sort(key=lambda n: n["position"])
    for n in by_id.values():
        n["children"].sort(key=lambda c: c["position"])
    return roots


@router.get("/task/{task_id}/workflow")
async def get_workflow(task_id: int, request: Request):
    repo = request.app.state.repo
    nodes = repo.list_workflow_nodes(task_id)
    edges = repo.list_workflow_edges(task_id)
    return {"nodes": _build_tree(nodes), "edges": edges}


@router.post("/task/{task_id}/workflow")
async def add_top_node(task_id: int, body: NodeCreate, request: Request):
    repo = request.app.state.repo
    existing = repo.list_workflow_nodes(task_id)
    top_level = [n for n in existing if n["parent_node_id"] is None]
    position = max((n["position"] for n in top_level), default=-1) + 1
    node_id = repo.add_workflow_node(
        task_id=task_id,
        title=body.title,
        time_estimate=body.time_estimate,
        depends_on_id=body.depends_on_id,
        position=position,
    )
    return {"id": node_id}


@router.post("/task/{task_id}/edges")
async def add_edge(task_id: int, body: EdgeCreate, request: Request):
    repo = request.app.state.repo
    if body.edge_type not in ("sequence", "dependency"):
        raise HTTPException(status_code=400, detail="edge_type must be 'sequence' or 'dependency'")
    src_node = repo.get_workflow_node(body.source_node_id)
    if not src_node:
        raise HTTPException(status_code=404, detail="source node not found")
    tgt_node = repo.get_workflow_node(body.target_node_id)
    if not tgt_node:
        raise HTTPException(status_code=404, detail="target node not found")
    if src_node["task_id"] != task_id or tgt_node["task_id"] != task_id:
        raise HTTPException(status_code=400, detail="nodes must belong to the specified task")
    edge_id = repo.add_workflow_edge(body.source_node_id, body.target_node_id, body.edge_type)
    return {"id": edge_id}


@router.delete("/edge/{edge_id}")
async def delete_edge(edge_id: int, request: Request):
    repo = request.app.state.repo
    if not repo.get_workflow_edge(edge_id):
        raise HTTPException(status_code=404, detail="edge not found")
    repo.delete_workflow_edge(edge_id)
    return {"ok": True}


@router.post("/node/{node_id}/children")
async def add_child_node(node_id: int, body: NodeCreate, request: Request):
    repo = request.app.state.repo
    parent = repo.get_workflow_node(node_id)
    if not parent:
        raise HTTPException(status_code=404, detail="node not found")
    siblings = [n for n in repo.list_workflow_nodes(parent["task_id"])
                if n["parent_node_id"] == node_id]
    position = max((n["position"] for n in siblings), default=-1) + 1
    child_id = repo.add_workflow_node(
        task_id=parent["task_id"],
        title=body.title,
        parent_node_id=node_id,
        time_estimate=body.time_estimate,
        position=position,
    )
    return {"id": child_id}


@router.patch("/node/{node_id}")
async def patch_node(node_id: int, body: NodePatch, request: Request):
    repo = request.app.state.repo
    if not repo.get_workflow_node(node_id):
        raise HTTPException(status_code=404, detail="node not found")
    kwargs = {k: v for k, v in body.model_dump().items() if v is not None}
    if kwargs:
        repo.update_workflow_node(node_id, **kwargs)
    return {"ok": True}


@router.delete("/node/{node_id}")
async def delete_node(node_id: int, request: Request):
    repo = request.app.state.repo
    if not repo.get_workflow_node(node_id):
        raise HTTPException(status_code=404, detail="node not found")
    repo.delete_workflow_node(node_id)
    return {"ok": True}
