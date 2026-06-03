// web/static/canvas.js
// Canvas engine for workflow canvas v2.
// Exposes:
//   window.openWorkflowCanvas(taskId, taskTitle, workItemTitle, taskRowEl)
//   window.closeWorkflowCanvas(taskRowEl?)  — no arg closes all

(function () {
  'use strict';

  const STATUS_CYCLE = { todo: 'done', done: 'kept', kept: 'skipped', skipped: 'todo' };
  const STATUS_ICON  = { todo: '○', done: '✓', kept: '★', skipped: '–' };
  const SNAP_THRESHOLD = 16; // px, snap trigger distance (canvas coords)

  // ── Global instance registry ────────────────────────────────────────────────
  const _instances = new Map(); // Map<taskRowEl, CanvasInstance>

  // ── Factory: create one independent canvas instance ─────────────────────────
  function _createInstance(tid, taskTitle, workItemTitle, taskRowEl) {
    const inst = {
      taskId: tid,
      taskRowEl,
      root: null, wrap: null, inner: null, svg: null,
      panX: 0, panY: 20, zoom: 1,
      isDraggingCanvas: false, panStart: null,
      draggingNode: null, dragNodeStart: null, dragMouseStart: null, dragAxisLocked: null,
      connectingFrom: null, tempEdgePath: null,
      nodes: [], edges: [],
      selectedEdgeId: null,
      isAddingNode: false,
      _boundMouseMove: null,
      _boundMouseUp: null,
    };

    // ── Build DOM ──────────────────────────────────────────────────────────────
    inst.root = document.createElement('div');
    inst.root.className = 'canvas-inline-root';
    inst.root.dataset.canvasTaskId = tid;
    taskRowEl.after(inst.root);

    _renderToolbar(inst, taskTitle, workItemTitle);

    inst.wrap  = document.createElement('div');
    inst.wrap.className = 'canvas-wrap';
    inst.inner = document.createElement('div');
    inst.inner.className = 'canvas-inner';
    inst.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    inst.svg.setAttribute('class', 'canvas-edges-svg');
    inst.inner.appendChild(inst.svg);
    inst.wrap.appendChild(inst.inner);
    inst.root.appendChild(inst.wrap);

    const legend = document.createElement('div');
    legend.className = 'canvas-legend';
    legend.innerHTML = `
      <div class="canvas-legend-row"><svg width="28" height="4"><line x1="0" y1="2" x2="28" y2="2" stroke="#58a6ff" stroke-width="1.5"/></svg> 顺序</div>
      <div class="canvas-legend-row"><svg width="28" height="4"><line x1="0" y1="2" x2="28" y2="2" stroke="#d29922" stroke-width="1.5" stroke-dasharray="4,2"/></svg> 依赖</div>
    `;
    inst.wrap.appendChild(legend);

    const hint = document.createElement('div');
    hint.className = 'canvas-hint';
    hint.textContent = '拖节点右侧蓝点连线 · 双击空白添加节点 · 按住Shift连依赖线';
    inst.wrap.appendChild(hint);

    _attachCanvasEvents(inst);

    return inst;
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────────
  function _renderToolbar(inst, taskTitle, workItemTitle) {
    const tb = document.createElement('div');
    tb.className = 'canvas-toolbar';
    tb.innerHTML = `
      <span class="toolbar-title">工作流画布</span>
      <span class="toolbar-task">/ ${_esc(workItemTitle)} / ${_esc(taskTitle)}</span>
      <div class="canvas-sep"></div>
      <button class="btn-canvas" data-cv="add-node">+ 节点</button>
      <div class="canvas-sep"></div>
      <button class="btn-canvas active" data-cv="expand-all">全部展开</button>
      <button class="btn-canvas" data-cv="collapse-all">全部收起</button>
      <div class="canvas-sep"></div>
      <button class="btn-canvas" data-cv="reset-view" title="重置视图">⊡ 重置</button>
      <button class="btn-canvas" data-cv="zoom-out" title="缩小">−</button>
      <span class="canvas-zoom-info" data-cv="zoom-label">100%</span>
      <button class="btn-canvas" data-cv="zoom-in" title="放大">＋</button>
      <div class="canvas-sep"></div>
      <button class="btn-canvas" data-cv="close" style="color:#f85149;border-color:#f85149">✕ 关闭</button>
    `;
    inst.root.appendChild(tb);

    tb.querySelector('[data-cv="close"]').onclick      = () => _closeInstance(inst);
    tb.querySelector('[data-cv="add-node"]').onclick   = () => _addNode(inst, 200, 200);
    tb.querySelector('[data-cv="expand-all"]').onclick   = () => _setAllCollapsed(inst, false);
    tb.querySelector('[data-cv="collapse-all"]').onclick = () => _setAllCollapsed(inst, true);
    tb.querySelector('[data-cv="reset-view"]').onclick   = () => _resetView(inst);
    tb.querySelector('[data-cv="zoom-out"]').onclick     = () => _stepZoom(inst, -0.1);
    tb.querySelector('[data-cv="zoom-in"]').onclick      = () => _stepZoom(inst, +0.1);
  }

  // ── View controls ───────────────────────────────────────────────────────────
  function _resetView(inst) {
    inst.panX = 0; inst.panY = 20; inst.zoom = 1;
    _updateTransform(inst);
    _updateZoomLabel(inst);
  }

  function _stepZoom(inst, delta) {
    const newZoom = Math.min(2, Math.max(0.3, inst.zoom + delta));
    const rect = inst.wrap.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    inst.panX = cx - (cx - inst.panX) * (newZoom / inst.zoom);
    inst.panY = cy - (cy - inst.panY) * (newZoom / inst.zoom);
    inst.zoom = newZoom;
    _updateTransform(inst);
    _updateZoomLabel(inst);
  }

  function _updateZoomLabel(inst) {
    const label = inst.root && inst.root.querySelector('[data-cv="zoom-label"]');
    if (label) label.textContent = Math.round(inst.zoom * 100) + '%';
  }

  function _updateTransform(inst) {
    inst.inner.style.transform = `translate(${inst.panX}px, ${inst.panY}px) scale(${inst.zoom})`;
  }

  // ── Data loading ────────────────────────────────────────────────────────────
  async function _loadAndRender(inst) {
    const resp = await fetch(`/api/task/${inst.taskId}/workflow`);
    const data = await resp.json();
    inst.nodes = data.nodes.map(n => ({ ...n }));
    inst.edges = data.edges || [];
    _renderAll(inst);
  }

  // ── Render all ──────────────────────────────────────────────────────────────
  function _renderAll(inst) {
    [...inst.inner.children].forEach(el => { if (el !== inst.svg) el.remove(); });
    inst.svg.innerHTML = _svgDefs();
    inst.inner.insertBefore(inst.svg, inst.inner.firstChild);
    inst.nodes.forEach(n => inst.inner.appendChild(_makeNodeEl(inst, n)));
    _renderEdges(inst);
    _updateTransform(inst);
    _fitCanvasHeight(inst);
  }

  const CANVAS_MIN_H = 160;
  const CANVAS_MAX_H = 420;
  const NODE_APPROX_H = 130; // approximate node card height in px

  function _fitCanvasHeight(inst) {
    if (!inst.nodes || inst.nodes.length === 0) {
      inst.wrap.style.height = CANVAS_MIN_H + 'px';
      return;
    }
    const maxBottom = Math.max(...inst.nodes.map(n => (n.pos_y || 0) + NODE_APPROX_H));
    const desired = Math.max(CANVAS_MIN_H, maxBottom + 40); // 40px padding below lowest node
    inst.wrap.style.height = Math.min(desired, CANVAS_MAX_H) + 'px';
  }

  function _svgDefs() {
    return `<defs>
      <marker id="cv-arr-blue" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6" fill="none" stroke="#58a6ff" stroke-width="1.5"/>
      </marker>
      <marker id="cv-arr-yellow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6" fill="none" stroke="#d29922" stroke-width="1.5"/>
      </marker>
    </defs>`;
  }

  // ── Node element ────────────────────────────────────────────────────────────
  function _makeNodeEl(inst, n) {
    const card = document.createElement('div');
    card.className = 'canvas-node'
      + (n.status === 'done' ? ' status-done' : n.status === 'kept' ? ' status-kept' : '')
      + (n.collapsed ? ' collapsed' : '');
    card.dataset.nodeId = n.id;
    card.style.left = n.pos_x + 'px';
    card.style.top  = n.pos_y + 'px';

    const tags = Array.isArray(n.custom_tags) ? n.custom_tags : [];
    const subtaskTotal = (n.children || []).length;
    const subtaskDone  = (n.children || []).filter(c => c.status === 'done').length;
    const badgeText    = `${subtaskDone}/${subtaskTotal}${n.assignee ? ' · ' + n.assignee : ''}`;

    card.innerHTML = `
      <div class="node-header">
        <button class="node-collapse-btn" title="${n.collapsed ? '展开' : '收起'}">${n.collapsed ? '▸' : '▾'}</button>
        <span class="node-status-icon">${STATUS_ICON[n.status] || '○'}</span>
        <span class="node-title-text">${_esc(n.title)}</span>
        <span class="collapsed-badge">${_esc(badgeText)}</span>
        <button class="node-del-btn">✕</button>
      </div>
      <div class="node-body">
        <div class="node-attrs">
          <div class="attr-row">
            <span class="attr-label">负责人</span>
            <div class="attr-chips">
              <span class="attr-chip person" data-field="assignee">${_esc(n.assignee || '—')}</span>
            </div>
          </div>
          <div class="attr-row">
            <span class="attr-label">截止</span>
            <div class="attr-chips">
              <span class="attr-chip date" data-field="due_date">${_esc(n.due_date || '—')}</span>
            </div>
          </div>
          <div class="attr-row">
            <span class="attr-label">时间</span>
            <div class="attr-chips">
              <span class="attr-chip time" data-field="time_estimate">${n.time_estimate ? n.time_estimate + 'min' : '—'}</span>
            </div>
          </div>
          <div class="attr-row">
            <span class="attr-label">标签</span>
            <div class="attr-chips" data-tags>
              ${tags.map(t => `<span class="attr-chip tag" data-tag="${_esc(t)}">${_esc(t)}</span>`).join('')}
              <button class="attr-chip add" data-add-tag>+</button>
            </div>
          </div>
        </div>
        <div class="node-subtasks">
          <div class="subtask-header"><span>子任务</span><span>${subtaskDone} / ${subtaskTotal}</span></div>
          ${(n.children || []).map(c => `
            <div class="subtask-row${c.status === 'done' ? ' done' : ''}" data-sub-id="${c.id}">
              <span class="subtask-icon">${STATUS_ICON[c.status] || '○'}</span>
              <span class="subtask-title">${_esc(c.title)}</span>
              ${c.assignee ? `<span class="subtask-person">${_esc(c.assignee)}</span>` : ''}
            </div>`).join('')}
          <button class="btn-add-subtask">+ 子任务</button>
        </div>
      </div>
      <div class="conn-port"></div>
    `;

    _attachNodeEvents(inst, card, n);
    return card;
  }

  // ── Node events ─────────────────────────────────────────────────────────────
  function _attachNodeEvents(inst, card, n) {
    const header = card.querySelector('.node-header');

    // Drag node
    header.addEventListener('mousedown', e => {
      if (e.target.closest('button') || e.target.closest('.node-status-icon')) return;
      e.stopPropagation();
      inst.draggingNode = card;
      inst.dragNodeStart  = { x: n.pos_x, y: n.pos_y };
      inst.dragMouseStart = { x: e.clientX, y: e.clientY };
      inst.dragAxisLocked = null;
      card.style.zIndex = 100;
    });

    // Status cycle
    card.querySelector('.node-status-icon').addEventListener('click', async e => {
      e.stopPropagation();
      const next = STATUS_CYCLE[n.status] || 'todo';
      n.status = next;
      await fetch(`/api/node/${n.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status: next}) });
      card.querySelector('.node-status-icon').textContent = STATUS_ICON[next];
      card.className = 'canvas-node'
        + (next === 'done' ? ' status-done' : next === 'kept' ? ' status-kept' : '')
        + (n.collapsed ? ' collapsed' : '');
    });

    // Collapse toggle
    card.querySelector('.node-collapse-btn').addEventListener('click', async e => {
      e.stopPropagation();
      n.collapsed = n.collapsed ? 0 : 1;
      card.classList.toggle('collapsed', !!n.collapsed);
      const btn = card.querySelector('.node-collapse-btn');
      btn.textContent = n.collapsed ? '▸' : '▾';
      btn.title = n.collapsed ? '展开' : '收起';
      await fetch(`/api/node/${n.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({collapsed: n.collapsed}) });
      _renderEdges(inst);
    });

    // Delete node
    card.querySelector('.node-del-btn').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`删除节点「${n.title}」？`)) return;
      await fetch(`/api/node/${n.id}`, { method: 'DELETE' });
      inst.nodes = inst.nodes.filter(x => x.id !== n.id);
      inst.edges = inst.edges.filter(x => x.source_node_id !== n.id && x.target_node_id !== n.id);
      card.remove();
      _renderEdges(inst);
      _fitCanvasHeight(inst);
    });

    // Inline attr editing
    card.querySelectorAll('.attr-chip[data-field]').forEach(chip => {
      chip.addEventListener('click', e => {
        e.stopPropagation();
        _startChipEdit(inst, chip, n, chip.dataset.field);
      });
    });

    // Add tag
    card.querySelector('[data-add-tag]').addEventListener('click', async e => {
      e.stopPropagation();
      const name = prompt('标签名（如 #写作）:');
      if (!name) return;
      const tags = Array.isArray(n.custom_tags) ? [...n.custom_tags] : [];
      tags.push(name);
      n.custom_tags = tags;
      await fetch(`/api/node/${n.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({custom_tags: JSON.stringify(tags)}) });
      const tagChip = document.createElement('span');
      tagChip.className = 'attr-chip tag';
      tagChip.dataset.tag = name;
      tagChip.textContent = name;
      card.querySelector('[data-add-tag]').before(tagChip);
    });

    // Add subtask
    card.querySelector('.btn-add-subtask').addEventListener('click', async e => {
      e.stopPropagation();
      const title = prompt('子任务名称:');
      if (!title) return;
      const resp = await fetch(`/api/node/${n.id}/children`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({title})
      });
      const {id} = await resp.json();
      const child = {id, title, status: 'todo', assignee: null};
      if (!n.children) n.children = [];
      n.children.push(child);
      const fresh = _makeNodeEl(inst, n);
      fresh.style.left = card.style.left;
      fresh.style.top  = card.style.top;
      card.replaceWith(fresh);
      _renderEdges(inst);
    });

    // Subtask status cycle
    card.querySelectorAll('.subtask-row').forEach(row => {
      const subId = parseInt(row.dataset.subId);
      row.querySelector('.subtask-icon').addEventListener('click', async e => {
        e.stopPropagation();
        const child = (n.children || []).find(c => c.id === subId);
        if (!child) return;
        const next = STATUS_CYCLE[child.status] || 'todo';
        child.status = next;
        await fetch(`/api/node/${subId}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status: next}) });
        row.querySelector('.subtask-icon').textContent = STATUS_ICON[next];
        row.classList.toggle('done', next === 'done');
        _refreshBadge(card, n);
      });
    });

    // Connection port
    const port = card.querySelector('.conn-port');
    port.addEventListener('mousedown', e => {
      e.stopPropagation();
      e.preventDefault();
      inst.connectingFrom = { nodeId: n.id, card };
      inst.tempEdgePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      inst.tempEdgePath.setAttribute('stroke', '#58a6ff');
      inst.tempEdgePath.setAttribute('stroke-width', '1.5');
      inst.tempEdgePath.setAttribute('fill', 'none');
      inst.tempEdgePath.setAttribute('opacity', '0.5');
      inst.svg.appendChild(inst.tempEdgePath);
    });
  }

  // ── Chip inline edit ────────────────────────────────────────────────────────
  function _startChipEdit(inst, chip, n, field) {
    const orig = chip.textContent.trim() === '—' ? '' : chip.textContent.trim().replace(/min$/, '');
    const inp = document.createElement('input');
    inp.className = 'node-inline-input';
    inp.value = orig;
    inp.style.width = '80px';
    chip.replaceWith(inp);
    inp.focus();
    let saved = false;
    const save = async () => {
      if (saved) return;
      saved = true;
      const val = inp.value.trim();
      const body = {};
      if (field === 'time_estimate') body[field] = val ? parseInt(val) : null;
      else body[field] = val || null;
      n[field] = val || null;
      await fetch(`/api/node/${n.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const newChip = document.createElement('span');
      newChip.className = 'attr-chip ' + (field === 'assignee' ? 'person' : field === 'due_date' ? 'date' : 'time');
      newChip.dataset.field = field;
      newChip.textContent = field === 'time_estimate' && val ? val + 'min' : (val || '—');
      inp.replaceWith(newChip);
      newChip.addEventListener('click', e => { e.stopPropagation(); _startChipEdit(inst, newChip, n, field); });
      _refreshBadge(newChip.closest('.canvas-node'), n);
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') inp.blur();
      if (e.key === 'Escape') inp.replaceWith(chip);
    });
  }

  function _refreshBadge(card, n) {
    if (!card) return;
    const subtaskDone  = (n.children || []).filter(c => c.status === 'done').length;
    const subtaskTotal = (n.children || []).length;
    const badgeText    = `${subtaskDone}/${subtaskTotal}${n.assignee ? ' · ' + n.assignee : ''}`;
    const badge = card.querySelector('.collapsed-badge');
    if (badge) badge.textContent = badgeText;
    const subHeader = card.querySelector('.subtask-header span:last-child');
    if (subHeader) subHeader.textContent = `${subtaskDone} / ${subtaskTotal}`;
  }

  // ── Edge rendering ──────────────────────────────────────────────────────────
  function _renderEdges(inst) {
    [...inst.svg.children].forEach(el => {
      if (el.tagName !== 'defs' && el !== inst.tempEdgePath) el.remove();
    });

    inst.edges.forEach(edge => {
      const srcCard = inst.inner.querySelector(`.canvas-node[data-node-id="${edge.source_node_id}"]`);
      const tgtCard = inst.inner.querySelector(`.canvas-node[data-node-id="${edge.target_node_id}"]`);
      if (!srcCard || !tgtCard) return;

      const {x1, y1, x2, y2} = _edgePoints(srcCard, tgtCard);
      const d = _bezierPath(x1, y1, x2, y2);
      const isSeq = edge.edge_type === 'sequence';
      const color  = isSeq ? '#58a6ff' : '#d29922';
      const marker = isSeq ? 'url(#cv-arr-blue)' : 'url(#cv-arr-yellow)';

      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'edge-hitarea');
      hit.addEventListener('click', () => _selectEdge(inst, edge.id));
      inst.svg.appendChild(hit);

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'edge-path' + (inst.selectedEdgeId === edge.id ? ' selected-edge' : ''));
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '1.5');
      if (!isSeq) path.setAttribute('stroke-dasharray', '5,3');
      path.setAttribute('marker-end', marker);
      path.setAttribute('opacity', '0.8');
      inst.svg.appendChild(path);
    });
  }

  function _edgePoints(srcCard, tgtCard) {
    const sx = parseFloat(srcCard.style.left), sy = parseFloat(srcCard.style.top);
    const tx = parseFloat(tgtCard.style.left), ty = parseFloat(tgtCard.style.top);
    return {
      x1: sx + srcCard.offsetWidth,  y1: sy + srcCard.offsetHeight / 2,
      x2: tx,                         y2: ty + tgtCard.offsetHeight / 2,
    };
  }

  function _bezierPath(x1, y1, x2, y2) {
    const dx = (x2 - x1) * 0.5;
    return `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function _selectEdge(inst, edgeId) {
    inst.selectedEdgeId = edgeId === inst.selectedEdgeId ? null : edgeId;
    inst.inner.querySelector('.edge-delete-btn')?.remove();
    _renderEdges(inst);
    if (inst.selectedEdgeId !== null) _showEdgeDeleteBtn(inst, inst.selectedEdgeId);
  }

  function _showEdgeDeleteBtn(inst, edgeId) {
    const edge = inst.edges.find(e => e.id === edgeId);
    if (!edge) return;
    const srcCard = inst.inner.querySelector(`.canvas-node[data-node-id="${edge.source_node_id}"]`);
    const tgtCard = inst.inner.querySelector(`.canvas-node[data-node-id="${edge.target_node_id}"]`);
    if (!srcCard || !tgtCard) return;
    const {x1, y1, x2, y2} = _edgePoints(srcCard, tgtCard);
    const btn = document.createElement('button');
    btn.className = 'btn-canvas edge-delete-btn';
    btn.style.cssText = `position:absolute;left:${(x1+x2)/2-20}px;top:${(y1+y2)/2-12}px;background:#1c2128;border-color:#f85149;color:#f85149;font-size:10px;z-index:50;`;
    btn.textContent = '删除连线';
    btn.addEventListener('click', async () => {
      await fetch(`/api/edge/${edgeId}`, {method:'DELETE'});
      inst.edges = inst.edges.filter(e => e.id !== edgeId);
      inst.selectedEdgeId = null;
      btn.remove();
      _renderEdges(inst);
    });
    inst.inner.appendChild(btn);
  }

  // ── Snap guides ─────────────────────────────────────────────────────────────
  function _computeSnap(inst, dragCard, newX, newY) {
    const dw = dragCard.offsetWidth;
    const dh = dragCard.offsetHeight;
    const T = SNAP_THRESHOLD;

    let snapX = null, snapY = null;
    let bestDx = T + 1, bestDy = T + 1;
    const guides = [];

    inst.inner.querySelectorAll('.canvas-node').forEach(other => {
      if (other === dragCard) return;
      const ox = parseFloat(other.style.left);
      const oy = parseFloat(other.style.top);
      const ow = other.offsetWidth;
      const oh = other.offsetHeight;

      // X-axis: left-align / right-align / butt right / butt left
      const xCandidates = [
        { val: ox,           diff: Math.abs(newX - ox) },
        { val: ox + ow - dw, diff: Math.abs(newX - (ox + ow - dw)) },
        { val: ox + ow,      diff: Math.abs(newX - (ox + ow)) },
        { val: ox - dw,      diff: Math.abs(newX - (ox - dw)) },
      ];
      for (const c of xCandidates) {
        if (c.diff < T && c.diff < bestDx) { bestDx = c.diff; snapX = c.val; }
      }

      // Y-axis: top-align / bottom-align / butt below / butt above
      const yCandidates = [
        { val: oy,           diff: Math.abs(newY - oy) },
        { val: oy + oh - dh, diff: Math.abs(newY - (oy + oh - dh)) },
        { val: oy + oh,      diff: Math.abs(newY - (oy + oh)) },
        { val: oy - dh,      diff: Math.abs(newY - (oy - dh)) },
      ];
      for (const c of yCandidates) {
        if (c.diff < T && c.diff < bestDy) { bestDy = c.diff; snapY = c.val; }
      }
    });

    if (snapX !== null) guides.push({ type: 'v', pos: snapX });
    if (snapY !== null) guides.push({ type: 'h', pos: snapY });

    return { snapX, snapY, guides };
  }

  function _clearGuides(inst) {
    inst.inner.querySelectorAll('.snap-guide').forEach(el => el.remove());
  }

  function _showGuides(inst, guides) {
    _clearGuides(inst);
    guides.forEach(g => {
      const el = document.createElement('div');
      el.className = 'snap-guide snap-guide-' + g.type;
      if (g.type === 'h') el.style.top  = g.pos + 'px';
      else                 el.style.left = g.pos + 'px';
      inst.inner.appendChild(el);
    });
  }

  // ── Canvas events ───────────────────────────────────────────────────────────
  function _attachCanvasEvents(inst) {
    inst._boundMouseMove = (e) => _onMouseMove(inst, e);
    inst._boundMouseUp   = (e) => _onMouseUp(inst, e);

    inst.wrap.addEventListener('mousedown', e => {
      if (e.target === inst.wrap || e.target === inst.inner) {
        inst.isDraggingCanvas = true;
        inst.panStart = { x: e.clientX - inst.panX, y: e.clientY - inst.panY };
        if (inst.selectedEdgeId !== null) {
          inst.selectedEdgeId = null;
          inst.inner.querySelector('.edge-delete-btn')?.remove();
          _renderEdges(inst);
        }
      }
    });

    window.addEventListener('mousemove', inst._boundMouseMove);
    window.addEventListener('mouseup',   inst._boundMouseUp);

    inst.wrap.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = inst.wrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.min(2, Math.max(0.3, inst.zoom * delta));
      inst.panX = mx - (mx - inst.panX) * (newZoom / inst.zoom);
      inst.panY = my - (my - inst.panY) * (newZoom / inst.zoom);
      inst.zoom = newZoom;
      _updateTransform(inst);
      _updateZoomLabel(inst);
    }, {passive: false});

    inst.wrap.addEventListener('dblclick', e => {
      if (e.target !== inst.wrap && e.target !== inst.inner) return;
      const rect = inst.wrap.getBoundingClientRect();
      const cx = (e.clientX - rect.left - inst.panX) / inst.zoom;
      const cy = (e.clientY - rect.top  - inst.panY) / inst.zoom;
      _addNode(inst, cx, cy);
    });
  }

  function _onMouseMove(inst, e) {
    if (!inst.wrap) return;

    if (inst.isDraggingCanvas && inst.panStart) {
      inst.panX = e.clientX - inst.panStart.x;
      inst.panY = e.clientY - inst.panStart.y;
      _updateTransform(inst);
    }

    if (inst.draggingNode && inst.dragNodeStart && inst.dragMouseStart) {
      const rawDx = (e.clientX - inst.dragMouseStart.x) / inst.zoom;
      const rawDy = (e.clientY - inst.dragMouseStart.y) / inst.zoom;
      if (!inst.dragAxisLocked && (Math.abs(rawDx) > 5 || Math.abs(rawDy) > 5)) {
        inst.dragAxisLocked = Math.abs(rawDx) >= Math.abs(rawDy) ? 'h' : 'v';
      }
      const dx = inst.dragAxisLocked === 'v' ? 0 : rawDx;
      const dy = inst.dragAxisLocked === 'h' ? 0 : rawDy;
      let newX = inst.dragNodeStart.x + dx;
      let newY = inst.dragNodeStart.y + dy;

      // Snap computation
      const snap = _computeSnap(inst, inst.draggingNode, newX, newY);
      if (snap.snapX !== null) newX = snap.snapX;
      if (snap.snapY !== null) newY = snap.snapY;
      _showGuides(inst, snap.guides);

      inst.draggingNode.style.left = newX + 'px';
      inst.draggingNode.style.top  = newY + 'px';
      _renderEdges(inst);
    }

    if (inst.connectingFrom && inst.tempEdgePath) {
      const rect = inst.wrap.getBoundingClientRect();
      const mx = (e.clientX - rect.left - inst.panX) / inst.zoom;
      const my = (e.clientY - rect.top  - inst.panY) / inst.zoom;
      const srcCard = inst.connectingFrom.card;
      const sx = parseFloat(srcCard.style.left) + srcCard.offsetWidth;
      const sy = parseFloat(srcCard.style.top)  + srcCard.offsetHeight / 2;
      inst.tempEdgePath.setAttribute('d', _bezierPath(sx, sy, mx, my));
    }
  }

  async function _onMouseUp(inst, e) {
    if (!inst.wrap) return;

    if (inst.draggingNode && inst.dragNodeStart && inst.dragMouseStart) {
      _clearGuides(inst);
      const nid = parseInt(inst.draggingNode.dataset.nodeId);
      const node = inst.nodes.find(n => n.id === nid);
      if (node) {
        node.pos_x = parseFloat(inst.draggingNode.style.left);
        node.pos_y = parseFloat(inst.draggingNode.style.top);
        await fetch(`/api/node/${nid}`, {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({pos_x: node.pos_x, pos_y: node.pos_y})
        });
        _fitCanvasHeight(inst);
      }
      inst.draggingNode.style.zIndex = '';
      inst.draggingNode = null; inst.dragNodeStart = null;
      inst.dragMouseStart = null; inst.dragAxisLocked = null;
    }

    if (inst.connectingFrom && inst.tempEdgePath) {
      inst.tempEdgePath.style.display = 'none';
      const elemUnder = document.elementFromPoint(e.clientX, e.clientY);
      inst.tempEdgePath.remove();
      inst.tempEdgePath = null;
      const targetCard = elemUnder && elemUnder.closest('.canvas-node');
      // Ensure target node belongs to this instance
      const targetInInst = targetCard && inst.inner.contains(targetCard);
      if (targetInInst && parseInt(targetCard.dataset.nodeId) !== inst.connectingFrom.nodeId) {
        const tgtId = parseInt(targetCard.dataset.nodeId);
        const edgeType = e.shiftKey ? 'dependency' : 'sequence';
        const resp = await fetch(`/api/task/${inst.taskId}/edges`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({source_node_id: inst.connectingFrom.nodeId, target_node_id: tgtId, edge_type: edgeType})
        });
        if (resp.ok) {
          const {id} = await resp.json();
          inst.edges.push({id, source_node_id: inst.connectingFrom.nodeId, target_node_id: tgtId, edge_type: edgeType});
          _renderEdges(inst);
        }
      }
      inst.connectingFrom = null;
    }

    inst.isDraggingCanvas = false; inst.panStart = null;
  }

  // ── Add node ────────────────────────────────────────────────────────────────
  async function _addNode(inst, cx, cy) {
    if (inst.isAddingNode) return;
    inst.isAddingNode = true;
    try {
      const title = prompt('节点名称:');
      if (!title) return;
      const resp = await fetch(`/api/task/${inst.taskId}/workflow`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({title})
      });
      const {id} = await resp.json();
      await fetch(`/api/node/${id}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({pos_x: cx, pos_y: cy})
      });
      const node = {id, title, status: 'todo', pos_x: cx, pos_y: cy, assignee: null,
                    due_date: null, custom_tags: [], collapsed: 0, time_estimate: null, children: []};
      inst.nodes.push(node);
      inst.inner.appendChild(_makeNodeEl(inst, node));
      _fitCanvasHeight(inst);
    } finally {
      inst.isAddingNode = false;
    }
  }

  // ── Expand / collapse all ───────────────────────────────────────────────────
  async function _setAllCollapsed(inst, val) {
    const v = val ? 1 : 0;
    await Promise.all(inst.nodes.map(n => {
      if (n.collapsed === v) return Promise.resolve();
      n.collapsed = v;
      return fetch(`/api/node/${n.id}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({collapsed: v})});
    }));
    inst.inner.querySelectorAll('.canvas-node').forEach(card => {
      card.classList.toggle('collapsed', !!val);
      const btn = card.querySelector('.node-collapse-btn');
      if (btn) { btn.textContent = val ? '▸' : '▾'; btn.title = val ? '展开' : '收起'; }
    });
    _renderEdges(inst);
  }

  // ── Close one instance ──────────────────────────────────────────────────────
  function _closeInstance(inst) {
    window.removeEventListener('mousemove', inst._boundMouseMove);
    window.removeEventListener('mouseup',   inst._boundMouseUp);
    if (inst.root) inst.root.remove();
    const btn = inst.taskRowEl && inst.taskRowEl.querySelector('.btn-workflow-toggle');
    if (btn) btn.classList.remove('open');
    _instances.delete(inst.taskRowEl);
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.openWorkflowCanvas = async function (tid, taskTitle, workItemTitle, taskRowEl) {
    // Toggle: if already open for this row, close it
    if (_instances.has(taskRowEl)) {
      _closeInstance(_instances.get(taskRowEl));
      return;
    }
    const inst = _createInstance(tid, taskTitle, workItemTitle, taskRowEl);
    _instances.set(taskRowEl, inst);

    const btn = taskRowEl.querySelector('.btn-workflow-toggle');
    if (btn) btn.classList.add('open');

    await _loadAndRender(inst);
  };

  // No arg → close all; with arg → close specific
  window.closeWorkflowCanvas = function (taskRowEl) {
    if (taskRowEl) {
      const inst = _instances.get(taskRowEl);
      if (inst) _closeInstance(inst);
    } else {
      _instances.forEach(inst => _closeInstance(inst));
    }
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function _esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

})();
