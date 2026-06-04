// web/static/app.js

// ── State ──────────────────────────────────────────────────────────────────
const ALL_TAGS = ['deadline', 'executor', 'score', 'importance', 'urgency'];
const DEFAULT_TAGS = ['deadline', 'executor', 'score'];
const LS_WI_LAYOUT = 'professor_os_wi_layout';

let wiViewLayout = localStorage.getItem(LS_WI_LAYOUT) || 'single';
const LS_KEY = 'professor_os_visible_tags';

let visibleTags = JSON.parse(localStorage.getItem(LS_KEY) || 'null') || [...DEFAULT_TAGS];
let scheduleData = [];
let _taskEditState = null;   // { task, wi, initialAssignments, currentAssignments }
let _peopleCache = null;     // cached GET /api/people result
let pendingResult = null;

// ── Schedule Plan state ────────────────────────────────────────────────────
const LS_SCHED_FILTER = 'sched_filter';
const LS_SCHED_LAYOUT = 'sched_layout';
let scheduleEntries = {};     // working (visual) state: {task_id(int): {is_current, date_start, date_end}}
let nodeEntries = {};          // working (visual) state: {node_id(int): {is_current, date_start, date_end}}
let dbEntries = {};            // last-saved DB state (deep copy of what's in DB)
let dbNodeEntries = {};        // last-saved DB state for nodes
let schedPlanFilter  = localStorage.getItem(LS_SCHED_FILTER) || 'active';
let schedPlanLayout  = localStorage.getItem(LS_SCHED_LAYOUT) || 'single';
const expandedTaskIds = new Set(); // task ids whose node panel is currently open
let peopleData = [];
let selectedPersonIds = new Set();
let peopleCardExpanded = false;
let peopleFilterMode = 'union'; // 'union' | 'intersect'
let peopleTaskColMode = 'single'; // 'single' | 'double'

// ── Meeting panel state ────────────────────────────────────────────────────
let _activeMeeting = null;       // full meeting object currently in panel
let _meetingPanelOpen = false;
let _taskPickMode = false;

// Undo history stack — max 20 ops
const MAX_UNDO = 20;
let undoStack = [];

// ── Theme & font size preferences ─────────────────────────────────────────

const FS_MAP = { sm: '1.07', md: '1.21', lg: '1.36' };

function _loadPrefs() {
  return JSON.parse(localStorage.getItem('prof_prefs') || '{}');
}

function _savePrefs(patch) {
  const p = { ..._loadPrefs(), ...patch };
  localStorage.setItem('prof_prefs', JSON.stringify(p));
}

function toggleSettingsPopover() {
  const pop = document.getElementById('settings-popover');
  if (pop.style.display === '') {
    closeSettingsPopover();
  } else {
    openSettingsPopover();
  }
}

function openSettingsPopover() {
  const pop = document.getElementById('settings-popover');
  pop.style.display = '';
  _syncSettingsUI();
  setTimeout(() => {
    document.addEventListener('click', _settingsOutsideClick, { once: true });
  }, 0);
}

function closeSettingsPopover() {
  document.getElementById('settings-popover').style.display = 'none';
}

function _settingsOutsideClick(e) {
  const pop = document.getElementById('settings-popover');
  const gear = document.querySelector('.settings-gear');
  if (pop && !pop.contains(e.target) && gear && !gear.contains(e.target)) {
    closeSettingsPopover();
  } else {
    document.addEventListener('click', _settingsOutsideClick, { once: true });
  }
}

function _syncSettingsUI() {
  const p = _loadPrefs();
  const theme = p.theme || 'dark';
  const size = p.fontSize || 'md';
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  document.querySelectorAll('.fontsize-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  _savePrefs({ theme });
  _syncSettingsUI();
}

function setFontSize(size) {
  if (!FS_MAP[size]) return;
  document.documentElement.style.setProperty('--fs', FS_MAP[size]);
  _savePrefs({ fontSize: size });
  _syncSettingsUI();
}

// ── Dedup state ────────────────────────────────────────────────────────────
let dedupPairs = [];          // [{taskA, taskB, wiA, wiB, source, reason}]
const dedupSkipped = new Set(); // "idA-idB" keys to ignore

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function pushUndo(op) {
  undoStack.push(op);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

async function popUndo() {
  const op = undoStack.pop();
  if (!op) return;

  if (op.type === 'delete_task') {
    await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'tasks', id: op.taskId }),
    });
  } else if (op.type === 'delete_work_item') {
    await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'work_items', id: op.wiId }),
    });
  } else if (op.type === 'rename_task') {
    await fetch(`/api/task/${op.taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: op.oldTitle }),
    });
  } else if (op.type === 'rename_work_item') {
    await fetch(`/api/work_item/${op.workItemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: op.oldTitle }),
    });
  } else if (op.type === 'reorder_tasks') {
    await Promise.all(op.prevOrder.map((taskId, idx) =>
      fetch(`/api/task/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: idx }),
      })
    ));
  } else if (op.type === 'reorder_work_items') {
    await Promise.all(op.prevOrder.map((wiId, idx) =>
      fetch(`/api/work_item/${wiId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sort_order: idx }),
      })
    ));
  }

  const resp = await fetch('/api/schedule');
  scheduleData = (await resp.json()).work_items;
  renderSchedulePlan();
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function loadData() {
  const [schedResp, entriesResp] = await Promise.all([
    fetch('/api/schedule'),
    fetch('/api/schedule_entries'),
  ]);
  const schedData = await schedResp.json();
  const entriesData = await entriesResp.json();
  scheduleData = schedData.work_items;
  scheduleEntries = {};
  for (const [k, v] of Object.entries(entriesData.entries)) {
    scheduleEntries[parseInt(k)] = v;
  }
  nodeEntries = {};
  for (const [k, v] of Object.entries(entriesData.node_entries || {})) {
    nodeEntries[parseInt(k)] = v;
  }
  // Snapshot DB state so we can detect unsaved changes
  dbEntries = JSON.parse(JSON.stringify(scheduleEntries));
  dbNodeEntries = JSON.parse(JSON.stringify(nodeEntries));
}

async function enterMainLayout() {
  document.getElementById('onboarding').classList.remove('visible');
  document.getElementById('layout').style.display = 'flex';
  const wiEl = document.getElementById('work-items');
  if (wiEl) wiEl.style.display = 'none';
  const trashEl = document.getElementById('trash-view');
  if (trashEl) trashEl.style.display = 'none';
  const peopleEl = document.getElementById('people-view');
  if (peopleEl) peopleEl.style.display = 'none';
  const schedEl = document.getElementById('schedule');
  schedEl.style.display = '';
  renderTagToolbar();
  showTagToolbar(false);
  schedEl.innerHTML = '<p style="color:#8b949e;padding:16px">加载中…</p>';
  try {
    await loadData();
  } catch (e) {
    schedEl.innerHTML = `<p style="color:var(--red);padding:16px">加载失败: ${esc(e.message)}</p>`;
    return;
  }
  renderSchedulePlan();
}

function showOnboardInput() {
  document.getElementById('onboard-landing').style.display = 'none';
  document.getElementById('onboard-step1').style.display = '';
  document.getElementById('onboarding-text').focus();
}

async function boot() {
  await enterMainLayout();
  // Show onboarding overlay only on a genuinely fresh install (no work items at all)
  if (scheduleData.length === 0) {
    document.getElementById('layout').style.display = 'none';
    document.getElementById('onboarding').classList.add('visible');
  }
  connectSSE();
}

// ── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('schedule_updated', async () => {
    await loadData();
    renderSchedulePlan();
  });
  // Tray pref changes: "pref:{"theme":"dark"}" or "pref:{"font_size":"lg"}"
  es.onmessage = e => {
    const data = e.data || '';
    if (data.startsWith('pref:')) {
      try {
        const p = JSON.parse(data.slice(5));
        if (p.theme) setTheme(p.theme);
        if (p.font_size) setFontSize(p.font_size);
      } catch (_) {}
    }
  };
}

async function fetchScheduleEntries() {
  const resp = await fetch('/api/schedule_entries');
  const data = await resp.json();
  scheduleEntries = {};
  for (const [k, v] of Object.entries(data.entries)) {
    scheduleEntries[parseInt(k)] = v;
  }
}

function getEffectiveEntry(task, taskById) {
  if (scheduleEntries[task.id]) {
    return { ...scheduleEntries[task.id], inherited: false };
  }
  if (task.parent_task_id && taskById[task.parent_task_id]) {
    const parent = taskById[task.parent_task_id];
    const parentEntry = getEffectiveEntry(parent, taskById);
    if (parentEntry) return { ...parentEntry, inherited: true };
  }
  return null;
}

function filterTaskForSchedView(task, taskById) {
  if (schedPlanFilter === 'all') return true;
  if (task.status === 'archived') return false;
  if (schedPlanFilter === 'active') return true;

  const entry = getEffectiveEntry(task, taskById);
  if (schedPlanFilter === 'current') {
    if (task.status === 'done') return false;
    if (!entry) return false;
    if (entry.is_current) return true;
    const today = new Date().toISOString().slice(0, 10);
    return entry.date_start <= today && today <= entry.date_end;
  }
  if (schedPlanFilter === 'upcoming') {
    if (task.status === 'done') return false;
    return !!entry;
  }
  return true;
}

// ── Tag toolbar ────────────────────────────────────────────────────────────
function renderTagToolbar() {
  const bar = document.getElementById('tag-toolbar');
  bar.innerHTML = '';

  ALL_TAGS.forEach(tag => {
    const chip = document.createElement('span');
    const isActive = visibleTags.includes(tag);
    chip.className = `chip ${isActive ? 'active' : 'inactive'}`;
    chip.dataset.tag = tag;

    if (isActive) {
      chip.innerHTML = `${tagLabel(tag)} <span class="chip-x" onclick="removeTag('${esc(tag)}', event)">✕</span>`;
    } else {
      chip.textContent = tagLabel(tag);
      chip.onclick = () => addTag(tag);
    }
    bar.appendChild(chip);
  });
}

function showTagToolbar(visible) {
  document.getElementById('tag-toolbar').style.display = visible ? '' : 'none';
}

function tagLabel(tag) {
  return { deadline: 'deadline', executor: 'executor', score: '★ 评分', importance: 'importance', urgency: 'urgency' }[tag] || tag;
}

function addTag(tag) {
  if (!visibleTags.includes(tag)) {
    visibleTags.push(tag);
    saveTags();
    renderTagToolbar();
    renderSchedulePlan();
    if (document.getElementById('work-items').style.display !== 'none') renderWorkItems();
  }
}

function removeTag(tag, e) {
  e.stopPropagation();
  visibleTags = visibleTags.filter(t => t !== tag);
  saveTags();
  renderTagToolbar();
  renderSchedulePlan();
  if (document.getElementById('work-items').style.display !== 'none') renderWorkItems();
}

function saveTags() {
  localStorage.setItem(LS_KEY, JSON.stringify(visibleTags));
}

// ── Dedup detection ────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m + 1}, (_, i) =>
    Array.from({length: n + 1}, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function isSimilar(a, b) {
  const ta = a.trim(), tb = b.trim();
  if (ta === tb) return true;
  if (ta.includes(tb) || tb.includes(ta)) return true;
  const dist = levenshtein(ta, tb);
  return dist / Math.max(ta.length, tb.length) < 0.4;
}

function scanForDuplicates() {
  const all = [];
  scheduleData.forEach(wi => {
    wi.tasks.forEach(task => all.push({task, wi}));
  });

  const newPairs = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const {task: tA, wi: wA} = all[i];
      const {task: tB, wi: wB} = all[j];
      const key = `${tA.id}-${tB.id}`;
      if (dedupSkipped.has(key)) continue;
      if (dedupPairs.some(p => p.taskA.id === tA.id && p.taskB.id === tB.id)) continue;
      if (isSimilar(tA.title, tB.title)) {
        newPairs.push({taskA: tA, taskB: tB, wiA: wA, wiB: wB, source: 'local', reason: ''});
      }
    }
  }
  const liveIds = new Set(all.map(x => x.task.id));
  dedupPairs = dedupPairs.filter(p => liveIds.has(p.taskA.id) && liveIds.has(p.taskB.id));
  dedupPairs.push(...newPairs);
  renderDedupBanner();
}

function renderDedupBanner() {
  const banner = document.getElementById('dedup-banner');
  const label = document.getElementById('dedup-count-label');
  const cardsEl = document.getElementById('dedup-cards');

  if (!banner) return;
  if (dedupPairs.length === 0) {
    banner.classList.remove('visible');
    return;
  }

  banner.classList.add('visible');
  label.textContent = `⚠ 发现 ${dedupPairs.length} 对相似任务`;

  cardsEl.innerHTML = '';
  dedupPairs.forEach((pair, idx) => {
    const card = document.createElement('div');
    card.className = 'dedup-card';
    card.innerHTML = `
      <div class="dedup-tasks">
        <div class="dedup-task-line">
          <span class="dedup-task-wi">${esc(pair.wiA.title)}</span>${esc(pair.taskA.title)}
        </div>
        <div class="dedup-task-line">
          <span class="dedup-task-wi">${esc(pair.wiB.title)}</span>${esc(pair.taskB.title)}
        </div>
        ${pair.reason ? `<div class="dedup-reason">${esc(pair.reason)}</div>` : ''}
      </div>
      <div class="dedup-actions">
        <button class="btn-merge" onclick="dedupMerge(${idx}, 'A')">合并→前者</button>
        <button class="btn-merge" onclick="dedupMerge(${idx}, 'B')">合并→后者</button>
        <button onclick="dedupRelate(${idx}, 'childA')">前者是子任务</button>
        <button onclick="dedupRelate(${idx}, 'childB')">后者是子任务</button>
        <button onclick="dedupRelate(${idx}, 'followsA')">前者在后者之后</button>
        <button onclick="dedupRelate(${idx}, 'followsB')">后者在前者之后</button>
        <button class="btn-skip" onclick="dedupSkip(${idx})">跳过</button>
      </div>
    `;
    cardsEl.appendChild(card);
  });
}

function toggleDedupCards() {
  const cards = document.getElementById('dedup-cards');
  const btn = document.getElementById('dedup-toggle');
  if (!cards || !btn) return;
  const hidden = cards.style.display === 'none';
  cards.style.display = hidden ? 'flex' : 'none';
  cards.style.flexDirection = 'column';
  btn.textContent = hidden ? '收起' : '查看';
}

// ── Dedup action handlers ──────────────────────────────────────────────────

function dedupSkip(idx) {
  const pair = dedupPairs[idx];
  dedupSkipped.add(`${pair.taskA.id}-${pair.taskB.id}`);
  dedupPairs.splice(idx, 1);
  renderDedupBanner();
}

async function dedupMerge(idx, keep) {
  const pair = dedupPairs[idx];
  const [kept, removed] = keep === 'A'
    ? [pair.taskA, pair.taskB]
    : [pair.taskB, pair.taskA];

  const patch = {};
  if (!kept.due_date && removed.due_date) patch.due_date = removed.due_date;
  const keptExec = (kept.assignments || []).find(a => a.role_in_task === 'executor');
  const removedExec = (removed.assignments || []).find(a => a.role_in_task === 'executor');
  if (!keptExec && removedExec) patch.executor_name = removedExec.person_name;

  if (Object.keys(patch).length) {
    await fetch(`/api/task/${kept.id}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(patch),
    });
  }
  await fetch(`/api/task/${removed.id}`, {method: 'DELETE'});

  scheduleData.forEach(wi => {
    wi.tasks = wi.tasks.filter(t => t.id !== removed.id);
  });

  dedupPairs.splice(idx, 1);
  renderSchedulePlan();
}

async function dedupRelate(idx, rel) {
  const pair = dedupPairs[idx];
  let taskId, patch;
  if (rel === 'childA')   { taskId = pair.taskA.id; patch = {parent_task_id: pair.taskB.id}; }
  if (rel === 'childB')   { taskId = pair.taskB.id; patch = {parent_task_id: pair.taskA.id}; }
  if (rel === 'followsA') { taskId = pair.taskA.id; patch = {follows_task_id: pair.taskB.id}; }
  if (rel === 'followsB') { taskId = pair.taskB.id; patch = {follows_task_id: pair.taskA.id}; }

  await fetch(`/api/task/${taskId}`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(patch),
  });

  scheduleData.forEach(wi => {
    const t = wi.tasks.find(t => t.id === taskId);
    if (t) Object.assign(t, patch);
  });

  dedupPairs.splice(idx, 1);
  renderSchedulePlan();
}

async function runLlmScan() {
  const btn = document.getElementById('btn-llm-scan');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const resp = await fetch('/api/tasks/similar', {method: 'POST'});
    const data = await resp.json();
    const taskMap = {};
    scheduleData.forEach(wi => wi.tasks.forEach(t => { taskMap[t.id] = {task: t, wi}; }));
    (data.pairs || []).forEach(p => {
      const a = taskMap[p.task_a.id], b = taskMap[p.task_b.id];
      if (!a || !b) return;
      const key = `${a.task.id}-${b.task.id}`;
      if (dedupSkipped.has(key)) return;
      if (dedupPairs.some(x => x.taskA.id === a.task.id && x.taskB.id === b.task.id)) return;
      dedupPairs.push({taskA: a.task, taskB: b.task, wiA: a.wi, wiB: b.wi,
                       source: 'llm', reason: p.reason});
    });
    renderDedupBanner();
    const cards = document.getElementById('dedup-cards');
    if (cards.style.display === 'none' && dedupPairs.length > 0) toggleDedupCards();
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 深度扫描';
  }
}

// ── Schedule tree ──────────────────────────────────────────────────────────
function makeTaskRow(task, idx, wi, childrenOf = {}, taskTitleById = {}) {
  const row = document.createElement('div');
  row.className = 'task-row';
  row.dataset.taskId = task.id;

  const priorityEl = document.createElement('span');
  priorityEl.className = 'task-priority';
  priorityEl.textContent = `#${idx + 1}`;

  const titleEl = document.createElement('span');
  titleEl.className = 'task-title';
  titleEl.textContent = task.title;
  titleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    startEditTaskTitle(titleEl, task);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'task-del';
  delBtn.textContent = '✕';
  delBtn.title = '删除任务';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteTask(task.id, task.title, row, wi);
  });

  row.appendChild(priorityEl);
  row.appendChild(titleEl);

  if (visibleTags.includes('executor')) {
    const assignments = (task.assignments || []).filter(a => a.person_name);
    if (assignments.length) {
      const wrap = document.createElement('span');
      wrap.className = 'task-assignees';
      assignments.forEach(a => {
        const span = document.createElement('span');
        const isExtra = a.role_in_task !== 'executor';
        span.className = 'task-tag executor clickable-person' + (isExtra ? ' extra-person' : '');
        span.textContent = a.person_name;
        span.addEventListener('click', (e) => { e.stopPropagation(); openPersonCard(span, a.person_name, task.id); });
        wrap.appendChild(span);
      });
      row.appendChild(wrap);
    }
  }
  if (visibleTags.includes('deadline') && task.due_date) {
    const tag = document.createElement('span');
    tag.className = 'task-tag deadline';
    tag.textContent = `due:${task.due_date}`;
    row.appendChild(tag);
  }
  if (visibleTags.includes('score')) {
    const tag = document.createElement('span');
    tag.className = 'task-tag score';
    tag.textContent = `★${task.score}`;
    row.appendChild(tag);
  }
  if (visibleTags.includes('importance')) {
    const tag = document.createElement('span');
    tag.className = 'task-tag';
    tag.textContent = `重要${wi.importance}`;
    row.appendChild(tag);
  }
  if (visibleTags.includes('urgency')) {
    const tag = document.createElement('span');
    tag.className = 'task-tag';
    tag.textContent = `紧急${wi.urgency}`;
    row.appendChild(tag);
  }

  if (task.follows_task_id && taskTitleById[task.follows_task_id]) {
    const tag = document.createElement('span');
    tag.className = 'task-follows-tag';
    tag.textContent = `→ ${taskTitleById[task.follows_task_id]}`;
    row.appendChild(tag);
  }

  row.appendChild(delBtn);
  return row;
}

function startEditTaskTitle(titleEl, task) {
  if (titleEl.querySelector('input')) return;
  const oldTitle = task.title;
  const input = document.createElement('input');
  input.className = 'task-title-input';
  input.value = oldTitle;
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  function save() {
    const newTitle = input.value.trim() || oldTitle;
    if (newTitle !== oldTitle) {
      pushUndo({ type: 'rename_task', taskId: task.id, oldTitle });
      task.title = newTitle;
      fetch(`/api/task/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
    }
    titleEl.textContent = newTitle;
  }

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldTitle; input.blur(); }
  });
}

async function quickAddWorkItem() {
  const title = prompt('新建支线名称：');
  if (!title || !title.trim()) return;
  const res = await fetch('/api/work_item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim(), type: 'project', importance: 3, urgency: 3 }),
  });
  if (res.ok) loadSchedule();
}

async function quickAddTask(wiId, taskListEl, wi) {
  const title = prompt('新建任务名称：');
  if (!title || !title.trim()) return;
  const res = await fetch('/api/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim(), work_item_id: wiId }),
  });
  if (!res.ok) return;
  const { id } = await res.json();
  const newTask = { id, title: title.trim(), work_item_id: wiId, status: 'todo', ownership: 'self_lead', due_date: null, workflow_nodes: [] };
  wi.tasks.push(newTask);
  const wiTaskById = Object.fromEntries(wi.tasks.map(t => [t.id, t]));
  // Insert before the "+ 新建任务" row
  const addRow = taskListEl.querySelector('.wi-add-task-row');
  taskListEl.insertBefore(makeWiViewTaskRow(newTask, wi, wiTaskById), addRow);
}

function startEditWiTitle(titleEl, wi) {
  if (titleEl.querySelector('input')) return;
  const oldTitle = wi.title;
  const input = document.createElement('input');
  input.className = 'wi-title-input';
  input.value = oldTitle;
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  function save() {
    const newTitle = input.value.trim() || oldTitle;
    if (newTitle !== oldTitle) {
      pushUndo({ type: 'rename_work_item', workItemId: wi.id, oldTitle });
      wi.title = newTitle;
      fetch(`/api/work_item/${wi.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
    }
    titleEl.textContent = newTitle;
  }

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = oldTitle; input.blur(); }
  });
}

function openDeleteModal(title, scopeHtml, onConfirm) {
  document.getElementById('delete-modal-title').textContent = title;
  // scopeHtml must use esc() for any user-controlled content to prevent XSS
  document.getElementById('delete-modal-scope').innerHTML = scopeHtml;
  document.getElementById('btn-modal-confirm').onclick = () => {
    closeDeleteModal();
    onConfirm();
  };
  document.getElementById('delete-modal-overlay').classList.add('visible');
  document.getElementById('btn-modal-cancel').focus();
}

function closeDeleteModal() {
  document.getElementById('delete-modal-overlay').classList.remove('visible');
}

document.getElementById('delete-modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) closeDeleteModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDeleteModal();
});

async function deleteTask(taskId, taskTitle, cardEl, wi) {
  const scopeHtml = `将删除任务：<strong>${esc(taskTitle)}</strong>`;
  openDeleteModal('删除任务', scopeHtml, async () => {
    pushUndo({ type: 'delete_task', taskId, taskTitle, wiId: wi.id });
    cardEl.remove();
    wi.tasks = wi.tasks.filter(t => t.id !== taskId);
    await fetch(`/api/task/${taskId}`, { method: 'DELETE' });
  });
}

function startEditWiScore(scoreEl, wi) {
  if (scoreEl.querySelector('input')) return;
  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:11px;';
  wrap.innerHTML = `
    <label style="color:var(--text-dim)">重</label><input class="wi-score-input" type="number" min="1" max="5" value="${wi.importance}" style="width:32px">
    <label style="color:var(--text-dim)">急</label><input class="wi-score-input" type="number" min="1" max="5" value="${wi.urgency}" style="width:32px">
  `;
  scoreEl.textContent = '';
  scoreEl.appendChild(wrap);
  const [impInput, urgInput] = wrap.querySelectorAll('input');
  impInput.focus();

  function save() {
    const imp = Math.min(5, Math.max(1, parseInt(impInput.value) || wi.importance));
    const urg = Math.min(5, Math.max(1, parseInt(urgInput.value) || wi.urgency));
    if (imp !== wi.importance || urg !== wi.urgency) {
      wi.importance = imp;
      wi.urgency = urg;
      fetch(`/api/work_item/${wi.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importance: imp, urgency: urg }),
      });
    }
    scoreEl.textContent = `重${imp} 急${urg}`;
    scoreEl.title = `重要性 ${imp} · 紧急程度 ${urg} (点击编辑)`;
  }

  function onBlur(e) {
    // Only save when focus moves outside the score editor entirely
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    save();
  }
  impInput.addEventListener('blur', onBlur);
  urgInput.addEventListener('blur', onBlur);
  [impInput, urgInput].forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); inp === impInput ? urgInput.focus() : inp.blur(); }
    if (e.key === 'Escape') { scoreEl.textContent = `重${wi.importance} 急${wi.urgency}`; }
  }));
}

async function deleteWorkItem(wiId, wiTitle, colEl) {
  const taskCount = scheduleData.find(w => w.id === wiId)?.tasks?.length ?? 0;
  const scopeHtml = `将删除支线：<strong>${esc(wiTitle)}</strong><br>包含 <strong>${taskCount}</strong> 个任务（可从垃圾桶还原）`;
  openDeleteModal('删除支线', scopeHtml, async () => {
    pushUndo({ type: 'delete_work_item', wiId, wiTitle });
    colEl.remove();
    scheduleData = scheduleData.filter(w => w.id !== wiId);
    await fetch(`/api/work_item/${wiId}`, { method: 'DELETE' });
  });
}

// ── View switching ─────────────────────────────────────────────────────────
function showView(view, evt) {
  // Prompt if leaving schedule with unsaved changes
  const currentlyOnSchedule = document.getElementById('schedule').style.display !== 'none';
  if (view !== 'schedule' && currentlyOnSchedule && hasUnsavedSchedule()) {
    const save = window.confirm('排期有未保存的修改，是否保存？\n\n确定 = 保存后跳转，取消 = 放弃修改后跳转');
    if (save) {
      saveSchedule().then(() => _doShowView(view, evt));
      return;
    } else {
      discardSchedule();
    }
  }
  _doShowView(view, evt);
}

function _doShowView(view, evt) {
  document.querySelectorAll('#sidebar nav a').forEach(a => a.classList.remove('active'));
  if (evt && evt.target) evt.target.classList.add('active');

  const scheduleEl = document.getElementById('schedule');
  const wiEl = document.getElementById('work-items');
  const trashEl = document.getElementById('trash-view');
  const peopleEl = document.getElementById('people-view');

  scheduleEl.style.display = 'none';
  wiEl.style.display = 'none';
  trashEl.style.display = 'none';
  peopleEl.style.display = 'none';
  showTagToolbar(view === 'work_items');

  if (view === 'schedule') {
    scheduleEl.style.display = '';
    loadData().then(() => renderSchedulePlan());
  } else if (view === 'work_items') {
    wiEl.style.display = '';
    renderWorkItems();
  } else if (view === 'trash') {
    trashEl.style.display = '';
    renderTrash();
  } else if (view === 'people') {
    peopleEl.style.display = '';
    renderPeople();
  }
}

async function renderTrash() {
  const container = document.getElementById('trash-view');
  container.innerHTML = '<h2>垃圾桶 — 已删除项目（可从此处还原）</h2>';

  let data;
  try {
    const resp = await fetch('/api/trash');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    container.innerHTML += `<p style="color:var(--red);padding:16px">加载垃圾桶失败: ${esc(e.message)}</p>`;
    return;
  }

  const { work_items, tasks } = data;

  // Work items section
  const wiSection = document.createElement('div');
  wiSection.className = 'trash-section';
  wiSection.innerHTML = '<h3>支线</h3>';
  if (work_items.length === 0) {
    wiSection.innerHTML += '<div class="trash-empty">无已删除支线</div>';
  } else {
    work_items.forEach(wi => {
      const item = document.createElement('div');
      item.className = 'trash-item';
      const titleEl = document.createElement('span');
      titleEl.className = 'trash-item-title';
      titleEl.textContent = wi.title;
      const metaEl = document.createElement('span');
      metaEl.className = 'trash-item-meta';
      metaEl.textContent = `${wi.deleted_task_count} 个任务`;
      const btn = document.createElement('button');
      btn.className = 'trash-restore-btn';
      btn.textContent = '还原';
      btn.dataset.table = 'work_items';
      btn.dataset.id = wi.id;
      btn.addEventListener('click', () => restoreItem('work_items', wi.id, btn));
      item.appendChild(titleEl);
      item.appendChild(metaEl);
      item.appendChild(btn);
      wiSection.appendChild(item);
    });
  }
  container.appendChild(wiSection);

  // Tasks section
  const tSection = document.createElement('div');
  tSection.className = 'trash-section';
  tSection.innerHTML = '<h3>任务</h3>';
  if (tasks.length === 0) {
    tSection.innerHTML += '<div class="trash-empty">无已删除任务</div>';
  } else {
    tasks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'trash-item';
      const titleEl = document.createElement('span');
      titleEl.className = 'trash-item-title';
      titleEl.textContent = task.title;
      const btn = document.createElement('button');
      btn.className = 'trash-restore-btn';
      btn.textContent = '还原';
      btn.addEventListener('click', () => restoreItem('tasks', task.id, btn));
      item.appendChild(titleEl);
      item.appendChild(btn);
      tSection.appendChild(item);
    });
  }
  container.appendChild(tSection);
}

async function restoreItem(table, id, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = '还原中…';
  try {
    const resp = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, id }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    await renderTrash();
    const schedResp = await fetch('/api/schedule');
    scheduleData = (await schedResp.json()).work_items;
  } catch (e) {
    btnEl.disabled = false;
    btnEl.textContent = '还原';
    alert('还原失败: ' + e.message);
  }
}

// ── People view ────────────────────────────────────────────────────────────

async function renderPeople() {
  const container = document.getElementById('people-view');
  container.innerHTML = '<p style="color:#8b949e;padding:16px">加载中…</p>';

  try {
    const [peopleResp] = await Promise.all([
      fetch('/api/people'),
      scheduleData.length === 0 ? loadData() : Promise.resolve(),
    ]);
    const data = await peopleResp.json();
    peopleData = data.people;
  } catch (e) {
    container.innerHTML = `<p style="color:var(--red);padding:16px">加载失败: ${esc(e.message)}</p>`;
    return;
  }

  container.innerHTML = '';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'people-toolbar';
  toolbar.innerHTML = `
    <button class="people-toolbar-btn" onclick="togglePeopleCardMode()">${peopleCardExpanded ? '缩略' : '展开'}卡片</button>
    <button class="people-toolbar-btn people-filter-mode-btn${peopleFilterMode === 'union' ? ' active' : ''}" onclick="setPeopleFilterMode('union')">并集</button>
    <button class="people-toolbar-btn people-filter-mode-btn${peopleFilterMode === 'intersect' ? ' active' : ''}" onclick="setPeopleFilterMode('intersect')">交集</button>
    <button class="people-toolbar-btn people-add-btn" onclick="openAddPersonPopover(this)">+ 新增人员</button>
    <span style="flex:1"></span>
    <button class="people-toolbar-btn" onclick="openMeetingHistory()">历史会议</button>
    <button class="people-toolbar-btn people-meeting-btn${_meetingPanelOpen ? ' open' : ''}" id="meeting-toggle-btn" onclick="toggleMeetingPanel()">📋 会议安排</button>
  `;
  container.appendChild(toolbar);

  // Card panel
  const cardPanel = document.createElement('div');
  cardPanel.className = 'people-card-panel';

  // Left column: students
  const leftCol = document.createElement('div');
  leftCol.className = 'people-col';
  leftCol.innerHTML = '<div class="people-col-title">学生</div>';
  _appendPeopleGroup(leftCol, '本科生', peopleData.filter(p => p.role === 'undergraduate'));
  _appendPeopleGroup(leftCol, '硕士',   peopleData.filter(p => p.role === 'master'));
  _appendPeopleGroup(leftCol, '博士',   peopleData.filter(p => p.role === 'phd'));

  // Right column: collaborators
  const rightCol = document.createElement('div');
  rightCol.className = 'people-col';
  rightCol.innerHTML = '<div class="people-col-title">合作者</div>';
  _appendPeopleGroup(rightCol, '老师',   peopleData.filter(p => p.role === 'collaborator_teacher'));
  _appendPeopleGroup(rightCol, '医生',   peopleData.filter(p => p.role === 'clinician'));
  _appendPeopleGroup(rightCol, '同行',   peopleData.filter(p => p.role === 'peer'));
  _appendPeopleGroup(rightCol, '其他',   peopleData.filter(p => p.role === 'other'));

  cardPanel.appendChild(leftCol);
  cardPanel.appendChild(rightCol);
  container.appendChild(cardPanel);

  // Task area
  const taskArea = document.createElement('div');
  taskArea.id = 'people-task-area';
  taskArea.className = 'people-task-area';
  container.appendChild(taskArea);

  _renderPeopleTaskArea();
}

function _appendPeopleGroup(col, label, people) {
  if (people.length === 0) return;
  const group = document.createElement('div');
  group.className = 'people-group';
  group.innerHTML = `<div class="people-group-label">${esc(label)}</div>`;
  const cards = document.createElement('div');
  cards.className = 'people-cards';
  people.forEach(p => cards.appendChild(_makePersonCard(p)));
  group.appendChild(cards);
  col.appendChild(group);
}

function togglePeopleCardMode() {
  peopleCardExpanded = !peopleCardExpanded;
  // Rebuild card panel in-place without re-fetching
  const container = document.getElementById('people-view');
  if (!container || !peopleData.length) { renderPeople(); return; }

  // Update toolbar button text
  const btn = container.querySelector('.people-toolbar-btn');
  if (btn) btn.textContent = (peopleCardExpanded ? '缩略' : '展开') + '卡片';

  // Rebuild card panel
  const oldPanel = container.querySelector('.people-card-panel');
  if (!oldPanel) { renderPeople(); return; }

  const cardPanel = document.createElement('div');
  cardPanel.className = 'people-card-panel';

  const leftCol = document.createElement('div');
  leftCol.className = 'people-col';
  leftCol.innerHTML = '<div class="people-col-title">学生</div>';
  _appendPeopleGroup(leftCol, '本科生', peopleData.filter(p => p.role === 'undergraduate'));
  _appendPeopleGroup(leftCol, '硕士',   peopleData.filter(p => p.role === 'master'));
  _appendPeopleGroup(leftCol, '博士',   peopleData.filter(p => p.role === 'phd'));

  const rightCol = document.createElement('div');
  rightCol.className = 'people-col';
  rightCol.innerHTML = '<div class="people-col-title">合作者</div>';
  _appendPeopleGroup(rightCol, '老师',   peopleData.filter(p => p.role === 'collaborator_teacher'));
  _appendPeopleGroup(rightCol, '医生',   peopleData.filter(p => p.role === 'clinician'));
  _appendPeopleGroup(rightCol, '同行',   peopleData.filter(p => p.role === 'peer'));
  _appendPeopleGroup(rightCol, '其他',   peopleData.filter(p => p.role === 'other'));

  cardPanel.appendChild(leftCol);
  cardPanel.appendChild(rightCol);
  oldPanel.replaceWith(cardPanel);
}

function _makePersonCard(person) {
  const card = document.createElement('div');
  card.className = `people-card${selectedPersonIds.has(person.id) ? ' selected' : ''}${peopleCardExpanded ? ' expanded' : ''}`;
  card.dataset.personId = person.id;

  const roleLabel = {
    undergraduate: '本科', master: '硕士', phd: '博士',
    collaborator_teacher: '老师', clinician: '医生', peer: '同行', other: '其他'
  };

  if (!peopleCardExpanded) {
    card.innerHTML = `
      <span class="people-card-name">${esc(person.name)}</span>
      <span class="people-card-role-tag">${roleLabel[person.role] || person.role}</span>
      <span class="people-card-count">${person.task_count}</span>
    `;
  } else {
    const bw = Math.min((person.scheduled_count || 0) * 25, 100);
    const filledBars = Math.round(bw / 10);
    const bars = '█'.repeat(filledBars) + '░'.repeat(10 - filledBars);
    const isFollowed = selectedPersonIds.has(person.id);
    card.innerHTML = `
      <div class="people-card-row">
        <span class="people-card-name">${esc(person.name)}</span>
        <button class="people-card-edit-btn" title="编辑">✎</button>
      </div>
      <div class="people-card-detail">角色: ${roleLabel[person.role] || person.role}</div>
      ${person.expertise ? `<div class="people-card-detail">专长: ${esc(person.expertise)}</div>` : ''}
      <div class="people-card-detail">带宽: ${bw}% <span class="people-card-bars">${bars}</span></div>
      <div class="people-card-detail">任务: ${person.task_count} 个</div>
      <div class="people-card-actions">
        <button class="people-card-follow-btn${isFollowed ? ' active' : ''}" title="${isFollowed ? '取消关注' : '关注'}">${isFollowed ? '★ 已关注' : '☆ 关注'}</button>
        <button class="people-card-delete-btn" title="删除">🗑 删除</button>
      </div>
    `;
    card.querySelector('.people-card-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditPersonPopover(e.currentTarget, person);
    });
    card.querySelector('.people-card-follow-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedPersonIds.has(person.id)) {
        selectedPersonIds.delete(person.id);
        card.classList.remove('selected');
        e.currentTarget.className = 'people-card-follow-btn';
        e.currentTarget.textContent = '☆ 关注';
      } else {
        selectedPersonIds.add(person.id);
        card.classList.add('selected');
        e.currentTarget.className = 'people-card-follow-btn active';
        e.currentTarget.textContent = '★ 已关注';
      }
      _renderPeopleTaskArea();
    });
    card.querySelector('.people-card-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`确认删除「${person.name}」？此操作不可撤销。`)) return;
      fetch(`/api/people/${person.id}`, { method: 'DELETE' })
        .then(r => { if (r.ok) { selectedPersonIds.delete(person.id); renderPeople(); } else { alert('删除失败'); } });
    });
  }

  card.addEventListener('click', (e) => {
    if (e.target.closest('.people-card-edit-btn,.people-card-follow-btn,.people-card-delete-btn')) return;
    if (selectedPersonIds.has(person.id)) {
      selectedPersonIds.delete(person.id);
      card.classList.remove('selected');
    } else {
      selectedPersonIds.add(person.id);
      card.classList.add('selected');
    }
    _renderPeopleTaskArea();
  });

  return card;
}

function _renderPeopleTaskArea() {
  const area = document.getElementById('people-task-area');
  if (!area) return;
  area.innerHTML = '';

  if (selectedPersonIds.size === 0) {
    area.innerHTML = '<p style="color:#8b949e;padding:16px">请选择人员查看相关任务</p>';
    return;
  }

  const selectedArr = [...selectedPersonIds];
  let anyBlock = false;

  // Collect matching wi blocks
  const blocks = [];
  let globalIdx = 0;
  scheduleData.forEach(wi => {
    const filteredTasks = wi.tasks.filter(t => {
      const taskPersonIds = (t.assignments || []).map(a => a.person_id);
      if (peopleFilterMode === 'intersect') {
        return selectedArr.every(id => taskPersonIds.includes(id));
      } else {
        return selectedArr.some(id => taskPersonIds.includes(id));
      }
    });
    if (filteredTasks.length === 0) return;

    const wiFiltered = { ...wi, tasks: filteredTasks };
    const block = _makeWiBlock(wiFiltered, globalIdx);
    if (block) { blocks.push(block); globalIdx++; anyBlock = true; }
  });

  if (!anyBlock) {
    area.innerHTML = '<p style="color:#8b949e;padding:16px">该人员暂无关联任务</p>';
    return;
  }

  // Toolbar row
  const taskToolbar = document.createElement('div');
  taskToolbar.className = 'people-task-toolbar';
  taskToolbar.innerHTML = `
    <button class="people-toolbar-btn people-task-col-btn${peopleTaskColMode === 'double' ? ' active' : ''}" onclick="togglePeopleTaskColMode()">${peopleTaskColMode === 'double' ? '双列' : '单列'}</button>
    <button class="people-toolbar-btn" onclick="openTaskExport()">导出任务</button>
  `;
  area.appendChild(taskToolbar);

  if (peopleTaskColMode === 'double') {
    const twoCol = document.createElement('div');
    twoCol.className = 'people-task-two-col';
    const col1 = document.createElement('div');
    col1.className = 'people-task-col';
    const col2 = document.createElement('div');
    col2.className = 'people-task-col';
    const half = Math.ceil(blocks.length / 2);
    blocks.slice(0, half).forEach(b => col1.appendChild(b));
    blocks.slice(half).forEach(b => col2.appendChild(b));
    twoCol.appendChild(col1);
    twoCol.appendChild(col2);
    area.appendChild(twoCol);
  } else {
    blocks.forEach(b => area.appendChild(b));
  }
}

function togglePeopleTaskColMode() {
  peopleTaskColMode = peopleTaskColMode === 'single' ? 'double' : 'single';
  _renderPeopleTaskArea();
}

// ── Task export ────────────────────────────────────────────────────────────

let _exportData = []; // [{wi, tasks:[task]}]

function openTaskExport() {
  const selectedArr = [...selectedPersonIds];
  _exportData = [];
  scheduleData.forEach(wi => {
    const filteredTasks = wi.tasks.filter(t => {
      const taskPersonIds = (t.assignments || []).map(a => a.person_id);
      if (peopleFilterMode === 'intersect') {
        return selectedArr.every(id => taskPersonIds.includes(id));
      } else {
        return selectedArr.some(id => taskPersonIds.includes(id));
      }
    });
    if (filteredTasks.length > 0) _exportData.push({ wi, tasks: filteredTasks });
  });

  const list = document.getElementById('task-export-checklist');
  list.innerHTML = '';

  _exportData.forEach((entry, wiIdx) => {
    // Build parent→children map for this wi's filtered tasks
    const taskById = {};
    entry.tasks.forEach(t => { taskById[t.id] = t; });
    const childrenOf = {};
    entry.tasks.forEach(t => {
      if (t.parent_task_id && taskById[t.parent_task_id]) {
        (childrenOf[t.parent_task_id] = childrenOf[t.parent_task_id] || []).push(t);
      }
    });
    const rootTasks = entry.tasks.filter(t => !t.parent_task_id || !taskById[t.parent_task_id]);

    // Work item checkbox
    const wiRow = document.createElement('div');
    wiRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0';
    const wiCb = document.createElement('input');
    wiCb.type = 'checkbox'; wiCb.checked = true;
    wiCb.id = `exp-wi-${wiIdx}`;
    wiCb.addEventListener('change', () => {
      list.querySelectorAll(`[data-wi-idx="${wiIdx}"]`).forEach(cb => { cb.checked = wiCb.checked; });
    });
    const wiLabel = document.createElement('label');
    wiLabel.htmlFor = wiCb.id;
    wiLabel.style.cssText = 'font-weight:600;font-size:13px;cursor:pointer';
    wiLabel.textContent = entry.wi.title;
    wiRow.appendChild(wiCb); wiRow.appendChild(wiLabel);
    list.appendChild(wiRow);

    // Recursive task checkboxes
    function addTaskRows(tasks, depth) {
      tasks.forEach(t => {
        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:6px;padding:2px 0 2px ${20 + depth * 16}px`;
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true;
        cb.id = `exp-t-${t.id}`;
        cb.dataset.wiIdx = wiIdx;
        cb.dataset.taskId = t.id;
        const label = document.createElement('label');
        label.htmlFor = cb.id;
        label.style.cssText = 'font-size:12px;color:var(--text-muted);cursor:pointer';
        const executor = (t.assignments || []).find(a => a.role_in_task === 'executor');
        label.textContent = t.title + (executor ? ` — ${executor.person_name}` : '');
        row.appendChild(cb); row.appendChild(label);
        list.appendChild(row);
        if (childrenOf[t.id]) addTaskRows(childrenOf[t.id], depth + 1);
      });
    }
    addTaskRows(rootTasks, 0);
  });

  document.getElementById('task-export-step1').style.display = '';
  document.getElementById('task-export-step2').style.display = 'none';
  document.getElementById('task-export-overlay').style.display = 'flex';
}

function closeTaskExport() {
  document.getElementById('task-export-overlay').style.display = 'none';
}

function taskExportSelectAll(checked) {
  document.getElementById('task-export-checklist').querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = checked; });
}

function taskExportBack() {
  document.getElementById('task-export-step1').style.display = '';
  document.getElementById('task-export-step2').style.display = 'none';
}

function taskExportGenerate() {
  const list = document.getElementById('task-export-checklist');
  const checkedTaskIds = new Set(
    [...list.querySelectorAll('input[data-task-id]:checked')].map(cb => parseInt(cb.dataset.taskId))
  );
  const today = new Date().toISOString().slice(0, 10);
  let md = `# 任务导出 ${today}\n\n`;

  // Level prefixes: L1=wi (1.), L2=root task (1.1), L3=child ((1)), L4=grandchild (a.)
  const alphaIdx = (n) => String.fromCharCode(96 + n); // 1→a, 2→b ...

  _exportData.forEach((entry, wiIdx) => {
    const wiCb = list.querySelector(`#exp-wi-${wiIdx}`);
    // Build task maps
    const taskById = {};
    entry.tasks.forEach(t => { taskById[t.id] = t; });
    const childrenOf = {};
    entry.tasks.forEach(t => {
      if (t.parent_task_id && taskById[t.parent_task_id]) {
        (childrenOf[t.parent_task_id] = childrenOf[t.parent_task_id] || []).push(t);
      }
    });
    const rootTasks = entry.tasks.filter(t => !t.parent_task_id || !taskById[t.parent_task_id]);

    // Check if any task in this wi is selected
    const anySelected = rootTasks.some(function hasAny(t) {
      return checkedTaskIds.has(t.id) || (childrenOf[t.id] || []).some(hasAny);
    });
    if (!anySelected && !(wiCb && wiCb.checked)) return;

    md += `1. **${entry.wi.title}**`;
    if (entry.wi.deadline) md += `（截止：${entry.wi.deadline}）`;
    md += '\n\n';

    let l2Idx = 0;
    function writeTask(t, depth, l2, l3Idx, l4Idx) {
      if (!checkedTaskIds.has(t.id)) {
        // still recurse into children if any are checked
        if (childrenOf[t.id]) {
          let l3 = 0;
          childrenOf[t.id].forEach(c => { writeTask(c, depth + 1, l2, l3++, 0); });
        }
        return;
      }
      const executor = (t.assignments || []).find(a => a.role_in_task === 'executor');
      const stakeholders = (t.assignments || []).filter(a => a.role_in_task === 'stakeholder');

      let prefix;
      if (depth === 0) prefix = `   ${l2}.`;
      else if (depth === 1) prefix = `      (${l3Idx + 1})`;
      else prefix = `         ${alphaIdx(l4Idx + 1)}.`;

      let line = `${prefix} ${t.title}`;
      if (executor) line += `（${executor.person_name}）`;
      if (stakeholders.length) line += `，合作者：${stakeholders.map(a => a.person_name).join('、')}`;
      if (t.due_date) line += `，${t.due_date}`;
      md += line + '\n';

      if (childrenOf[t.id]) {
        let l3 = 0, l4 = 0;
        childrenOf[t.id].forEach(c => {
          writeTask(c, depth + 1, l2, depth === 0 ? l3++ : 0, depth === 1 ? l4++ : 0);
        });
      }
    }

    rootTasks.forEach(t => { writeTask(t, 0, ++l2Idx, 0, 0); });
    md += '\n';
  });

  document.getElementById('task-export-text').value = md.trim();
  document.getElementById('task-export-step1').style.display = 'none';
  document.getElementById('task-export-step2').style.display = 'flex';
}

function taskExportCopy() {
  const ta = document.getElementById('task-export-text');
  ta.select();
  navigator.clipboard.writeText(ta.value).catch(() => document.execCommand('copy'));
}

function setPeopleFilterMode(mode) {
  peopleFilterMode = mode;
  // Update button styles in-place without full re-render
  document.querySelectorAll('.people-filter-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === (mode === 'union' ? '并集' : '交集'));
  });
  _renderPeopleTaskArea();
}

// ── Meeting panel ──────────────────────────────────────────────────────────

async function toggleMeetingPanel() {
  if (_meetingPanelOpen) {
    closeMeetingPanel();
  } else {
    const r = await fetch('/api/meetings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新会议' }),
    });
    const { id } = await r.json();
    const meeting = await (await fetch(`/api/meetings/${id}`)).json();
    openMeetingPanel(meeting);
  }
}

function openMeetingPanel(meeting) {
  _activeMeeting = meeting;
  _meetingPanelOpen = true;
  document.getElementById('meeting-panel').classList.add('open');
  document.getElementById('people-view').classList.add('meeting-open');
  const btn = document.getElementById('meeting-toggle-btn');
  if (btn) btn.classList.add('open');
  renderMeetingPanel();
}

function closeMeetingPanel() {
  _meetingPanelOpen = false;
  _activeMeeting = null;
  document.getElementById('meeting-panel').classList.remove('open');
  document.getElementById('people-view').classList.remove('meeting-open');
  exitTaskPickMode();
  const btn = document.getElementById('meeting-toggle-btn');
  if (btn) btn.classList.remove('open');
}

function renderMeetingPanel() {
  if (!_activeMeeting) return;
  const m = _activeMeeting;
  const el = document.getElementById('meeting-panel-inner');
  el.innerHTML = '';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'mp-header';
  const titleInput = document.createElement('input');
  titleInput.className = 'mp-title-input';
  titleInput.value = m.title || '新会议';
  titleInput.addEventListener('change', () => _mpSave({ title: titleInput.value }));
  const closeBtn = document.createElement('button');
  closeBtn.className = 'mp-close-btn';
  closeBtn.textContent = '×';
  closeBtn.onclick = closeMeetingPanel;
  header.appendChild(titleInput);
  header.appendChild(closeBtn);
  el.appendChild(header);

  // ── Status + Date ──
  const meta = document.createElement('div');
  meta.className = 'mp-meta';
  const statusSel = document.createElement('select');
  statusSel.className = 'mp-status-sel';
  [['planned','计划中'],['in_progress','进行中'],['done','已完成']].forEach(([v,l]) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = l;
    if (m.status === v) opt.selected = true;
    statusSel.appendChild(opt);
  });
  statusSel.addEventListener('change', () => _mpSave({ status: statusSel.value }));
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'mp-date-input';
  dateInput.value = m.scheduled_at || '';
  dateInput.addEventListener('change', () => _mpSave({ scheduled_at: dateInput.value || null }));
  meta.appendChild(statusSel);
  meta.appendChild(dateInput);
  el.appendChild(meta);

  // ── Members ──
  const ROLE_MAP = { organizer: '组织人', participant: '参与人', reporter: '汇报人' };
  ['organizer', 'participant', 'reporter'].forEach(role => {
    const sec = document.createElement('div');
    sec.className = 'mp-section';
    const lbl = document.createElement('div');
    lbl.className = 'mp-section-label';
    lbl.textContent = ROLE_MAP[role];
    sec.appendChild(lbl);

    const chips = document.createElement('div');
    chips.className = 'mp-members';
    (m.members || []).filter(mem => mem.role === role).forEach(mem => {
      const chip = document.createElement('span');
      chip.className = `mp-member-chip ${role}`;
      chip.innerHTML = `${esc(mem.person_name)}<span class="mp-chip-x" data-name="${esc(mem.person_name)}">×</span>`;
      chip.querySelector('.mp-chip-x').onclick = async (e) => {
        e.stopPropagation();
        await fetch(`/api/meetings/${m.id}/members/${encodeURIComponent(mem.person_name)}`, { method: 'DELETE' });
        _activeMeeting.members = _activeMeeting.members.filter(x => x.person_name !== mem.person_name);
        renderMeetingPanel();
      };
      chips.appendChild(chip);
    });
    sec.appendChild(chips);

    const addRow = document.createElement('div');
    addRow.className = 'mp-add-row';
    const nameInput = document.createElement('input');
    nameInput.className = 'mp-person-input';
    nameInput.placeholder = '输入姓名…';
    nameInput.setAttribute('list', `mp-datalist-${role}`);
    const dl = document.createElement('datalist');
    dl.id = `mp-datalist-${role}`;
    (peopleData || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; dl.appendChild(opt);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'mp-add-person-btn';
    addBtn.textContent = '+';
    addBtn.onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const existing = (peopleData || []).find(p => p.name === name);
      if (!existing) {
        await fetch('/api/people', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, role: 'other', expertise: '' }),
        });
      }
      const person = (peopleData || []).find(p => p.name === name);
      await fetch(`/api/meetings/${m.id}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_name: name, role, person_id: person?.id ?? null }),
      });
      nameInput.value = '';
      _activeMeeting = await (await fetch(`/api/meetings/${m.id}`)).json();
      renderMeetingPanel();
    };
    addRow.appendChild(nameInput);
    addRow.appendChild(dl);
    addRow.appendChild(addBtn);
    sec.appendChild(addRow);
    el.appendChild(sec);
  });

  // ── Meeting Tasks ──
  const taskSec = document.createElement('div');
  taskSec.className = 'mp-section';
  const taskLbl = document.createElement('div');
  taskLbl.className = 'mp-section-label';
  taskLbl.textContent = '会议内容';
  taskSec.appendChild(taskLbl);

  const taskList = document.createElement('div');
  taskList.className = 'mp-task-list';
  (m.tasks || []).forEach(t => {
    const row = document.createElement('div');
    row.className = 'mp-task-row';
    row.innerHTML = `
      <span class="mp-task-wi">${esc(t.wi_title)}</span>
      <span class="mp-task-title">${esc(_getTaskTitle(t.task_id))}</span>
    `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'mp-task-remove';
    removeBtn.textContent = '×';
    removeBtn.onclick = async () => {
      await fetch(`/api/meetings/${m.id}/tasks/${t.task_id}`, { method: 'DELETE' });
      _activeMeeting.tasks = _activeMeeting.tasks.filter(x => x.task_id !== t.task_id);
      renderMeetingPanel();
    };
    row.appendChild(removeBtn);
    taskList.appendChild(row);
  });
  taskSec.appendChild(taskList);

  const addTaskBtn = document.createElement('button');
  addTaskBtn.className = 'mp-add-task-btn';
  addTaskBtn.textContent = '+ 添加任务';
  addTaskBtn.onclick = enterTaskPickMode;
  taskSec.appendChild(addTaskBtn);
  el.appendChild(taskSec);

  // ── Meeting Notes ──
  const notesSec = document.createElement('div');
  notesSec.className = 'mp-section';
  const notesLbl = document.createElement('div');
  notesLbl.className = 'mp-section-label';
  notesLbl.textContent = '会议纪要';
  notesSec.appendChild(notesLbl);
  const notesTA = document.createElement('textarea');
  notesTA.className = 'mp-notes-textarea';
  notesTA.placeholder = '记录讨论要点、决定、下一步行动…';
  notesTA.value = m.notes?.content || '';
  notesTA.addEventListener('change', async () => {
    await fetch(`/api/meetings/${m.id}/notes`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: notesTA.value }),
    });
  });
  const parseBtn = document.createElement('button');
  parseBtn.className = 'mp-parse-btn';
  parseBtn.textContent = '解析并添加任务';
  parseBtn.onclick = () => _mpParseNotes(notesTA.value);
  notesSec.appendChild(notesTA);
  notesSec.appendChild(parseBtn);
  el.appendChild(notesSec);
}

async function _mpSave(patch) {
  if (!_activeMeeting) return;
  await fetch(`/api/meetings/${_activeMeeting.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  Object.assign(_activeMeeting, patch);
}

function _getTaskTitle(taskId) {
  for (const wi of scheduleData) {
    const t = wi.tasks.find(t => t.id === taskId);
    if (t) return t.title;
  }
  return `任务 #${taskId}`;
}

async function _mpParseNotes(text) {
  if (!text.trim()) { alert('纪要为空'); return; }
  const r = await fetch('/api/input', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const result = await r.json();
  if (result.error) { alert('解析失败: ' + result.error); return; }
  pendingResult = result;
  showConfirmPanel(result);
}

async function openMeetingHistory() {
  const r = await fetch('/api/meetings');
  const { meetings } = await r.json();
  const listEl = document.getElementById('meeting-history-list');
  listEl.innerHTML = '';
  if (meetings.length === 0) {
    listEl.innerHTML = '<p style="color:#8b949e;padding:16px">暂无历史会议</p>';
  } else {
    const statusLabel = { planned: '计划中', in_progress: '进行中', done: '已完成' };
    meetings.forEach(m => {
      const row = document.createElement('div');
      row.className = 'mh-row';
      row.innerHTML = `
        <span class="mh-status ${m.status}">${statusLabel[m.status] || m.status}</span>
        <span class="mh-title">${esc(m.title)}</span>
        <span class="mh-date">${m.scheduled_at || ''}</span>
      `;
      row.onclick = async () => {
        const full = await (await fetch(`/api/meetings/${m.id}`)).json();
        closeMeetingHistory();
        openMeetingPanel(full);
      };
      listEl.appendChild(row);
    });
  }
  document.getElementById('meeting-history-overlay').classList.add('visible');
}

function closeMeetingHistory() {
  document.getElementById('meeting-history-overlay').classList.remove('visible');
}

function enterTaskPickMode() {
  if (!_activeMeeting) return;
  _taskPickMode = true;
  const peopleView = document.getElementById('people-view');
  peopleView.classList.add('task-pick-mode');

  const area = document.getElementById('people-task-area');
  if (!area) return;
  const banner = document.createElement('div');
  banner.className = 'task-pick-banner';
  banner.id = 'task-pick-banner';
  banner.innerHTML = `
    <span>点击任务添加到会议内容</span>
    <button onclick="confirmTaskPick()">完成</button>
    <button class="tp-cancel" onclick="exitTaskPickMode()">取消</button>
  `;
  area.insertBefore(banner, area.firstChild);

  area.querySelectorAll('.wi-view-task-row, .task-row').forEach(row => {
    row.addEventListener('click', _onTaskPickClick);
  });
}

function exitTaskPickMode() {
  _taskPickMode = false;
  document.getElementById('people-view')?.classList.remove('task-pick-mode');
  document.getElementById('task-pick-banner')?.remove();
  document.querySelectorAll('.task-pick-selected').forEach(el => el.classList.remove('task-pick-selected'));
  document.querySelectorAll('.wi-view-task-row, .task-row').forEach(row => {
    row.removeEventListener('click', _onTaskPickClick);
  });
}

function _onTaskPickClick(e) {
  e.stopPropagation();
  const row = e.currentTarget;
  row.classList.toggle('task-pick-selected');
}

async function confirmTaskPick() {
  if (!_activeMeeting) return;
  const selected = document.querySelectorAll('.task-pick-selected');
  for (const row of selected) {
    const taskId = parseInt(row.dataset.taskId);
    if (!taskId) continue;
    let wiTitle = '';
    for (const wi of scheduleData) {
      if (wi.tasks.find(t => t.id === taskId)) { wiTitle = wi.title; break; }
    }
    if (_activeMeeting.tasks.some(t => t.task_id === taskId)) continue;
    await fetch(`/api/meetings/${_activeMeeting.id}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, wi_title: wiTitle }),
    });
  }
  _activeMeeting = await (await fetch(`/api/meetings/${_activeMeeting.id}`)).json();
  exitTaskPickMode();
  renderMeetingPanel();
}

let _activePopover = null;
let _activePopoverHandler = null;

function _closeActivePopover() {
  if (_activePopoverHandler) {
    document.removeEventListener('click', _activePopoverHandler);
    _activePopoverHandler = null;
  }
  if (_activePopover) { _activePopover.remove(); _activePopover = null; }
}

function _buildPersonForm(person) {
  const ROLES = [
    ['undergraduate','本科生'],['master','硕士'],['phd','博士'],
    ['collaborator_teacher','老师'],['clinician','医生'],['peer','同行'],['other','其他'],
  ];
  const roleOptions = ROLES.map(([v, l]) =>
    `<option value="${v}"${person && person.role === v ? ' selected' : ''}>${l}</option>`
  ).join('');
  return `
    <div class="people-popover-field"><label>姓名</label><input type="text" class="ppf-name" value="${esc(person?.name ?? '')}"></div>
    <div class="people-popover-field"><label>角色</label><select class="ppf-role">${roleOptions}</select></div>
    <div class="people-popover-field"><label>专长</label><input type="text" class="ppf-expertise" value="${esc(person?.expertise ?? '')}"></div>
  `;
}

function openEditPersonPopover(anchorEl, person) {
  _closeActivePopover();
  const popover = document.createElement('div');
  popover.className = 'people-popover';
  popover.innerHTML = `
    ${_buildPersonForm(person)}
    <div class="people-popover-actions">
      <button class="ppf-cancel">取消</button>
      <button class="ppf-save">保存</button>
    </div>
  `;
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  popover.style.left = (rect.right + window.scrollX - popover.offsetWidth) + 'px';
  _activePopover = popover;

  setTimeout(() => {
    _activePopoverHandler = function handler(e) {
      if (!popover.contains(e.target) && e.target !== anchorEl) {
        _closeActivePopover();
      }
    };
    document.addEventListener('click', _activePopoverHandler);
  }, 0);

  popover.querySelector('.ppf-cancel').onclick = _closeActivePopover;
  popover.querySelector('.ppf-save').onclick = async () => {
    const name = popover.querySelector('.ppf-name').value.trim();
    const role = popover.querySelector('.ppf-role').value;
    const expertise = popover.querySelector('.ppf-expertise').value.trim();
    if (!name) { alert('姓名不能为空'); return; }
    const resp = await fetch(`/api/people/${person.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role, expertise }),
    });
    if (!resp.ok) { alert(`保存失败 (${resp.status}): ${await resp.text()}`); return; }
    _closeActivePopover();
    renderPeople();
  };
}

function openAddPersonPopover(anchorEl) {
  _closeActivePopover();
  const popover = document.createElement('div');
  popover.className = 'people-popover';
  popover.innerHTML = `
    ${_buildPersonForm(null)}
    <div class="people-popover-actions">
      <button class="ppf-cancel">取消</button>
      <button class="ppf-save">添加</button>
    </div>
  `;
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  popover.style.left = (rect.left + window.scrollX) + 'px';
  _activePopover = popover;

  popover.querySelector('.ppf-cancel').onclick = _closeActivePopover;
  popover.querySelector('.ppf-save').onclick = async () => {
    const name = popover.querySelector('.ppf-name').value.trim();
    const role = popover.querySelector('.ppf-role').value;
    const expertise = popover.querySelector('.ppf-expertise').value.trim();
    if (!name) { alert('姓名不能为空'); return; }
    const resp = await fetch('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role, expertise }),
    });
    if (!resp.ok) { alert('添加失败'); return; }
    _closeActivePopover();
    renderPeople();
  };

  setTimeout(() => {
    _activePopoverHandler = function handler(e) {
      if (!popover.contains(e.target) && e.target !== anchorEl) {
        _closeActivePopover();
      }
    };
    document.addEventListener('click', _activePopoverHandler);
  }, 0);
}

function setWiLayout(mode) {
  wiViewLayout = mode;
  localStorage.setItem(LS_WI_LAYOUT, mode);
  renderWorkItems();
}

// ── Schedule Plan view ─────────────────────────────────────────────────────

function setSchedLayout(mode) {
  schedPlanLayout = mode;
  localStorage.setItem(LS_SCHED_LAYOUT, mode);
  renderSchedulePlan();
}

function setSchedFilter(mode) {
  schedPlanFilter = mode;
  localStorage.setItem(LS_SCHED_FILTER, mode);
  renderSchedulePlan();
}

// ── Schedule save / discard ───────────────────────────────────────────────

function hasUnsavedSchedule() {
  const eKeys = new Set([...Object.keys(scheduleEntries), ...Object.keys(dbEntries)]);
  for (const k of eKeys) {
    const a = scheduleEntries[parseInt(k)], b = dbEntries[parseInt(k)];
    if (!a && b) return true;
    if (a && !b) return true;
    if (a && b && (a.is_current !== b.is_current || a.date_start !== b.date_start || a.date_end !== b.date_end)) return true;
  }
  const nKeys = new Set([...Object.keys(nodeEntries), ...Object.keys(dbNodeEntries)]);
  for (const k of nKeys) {
    const a = nodeEntries[parseInt(k)], b = dbNodeEntries[parseInt(k)];
    if (!a && b) return true;
    if (a && !b) return true;
    if (a && b && (a.is_current !== b.is_current || a.date_start !== b.date_start || a.date_end !== b.date_end)) return true;
  }
  return false;
}

async function saveSchedule() {
  const ops = [];
  // Task entries: upsert changed, delete removed
  const eKeys = new Set([...Object.keys(scheduleEntries).map(Number), ...Object.keys(dbEntries).map(Number)]);
  for (const id of eKeys) {
    const cur = scheduleEntries[id], prev = dbEntries[id];
    if (!cur && prev) {
      ops.push(fetch(`/api/schedule_entries/${id}`, { method: 'DELETE' }));
    } else if (cur && (!prev || cur.is_current !== prev.is_current || cur.date_start !== prev.date_start || cur.date_end !== prev.date_end)) {
      ops.push(fetch('/api/schedule_entries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: id, is_current: cur.is_current, date_start: cur.date_start, date_end: cur.date_end }),
      }));
    }
  }
  // Node entries
  const nKeys = new Set([...Object.keys(nodeEntries).map(Number), ...Object.keys(dbNodeEntries).map(Number)]);
  for (const id of nKeys) {
    const cur = nodeEntries[id], prev = dbNodeEntries[id];
    if (!cur && prev) {
      ops.push(fetch(`/api/node_schedule_entries/${id}`, { method: 'DELETE' }));
    } else if (cur && (!prev || cur.is_current !== prev.is_current || cur.date_start !== prev.date_start || cur.date_end !== prev.date_end)) {
      ops.push(fetch('/api/node_schedule_entries', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: id, is_current: cur.is_current, date_start: cur.date_start, date_end: cur.date_end }),
      }));
    }
  }
  await Promise.all(ops);
  dbEntries = JSON.parse(JSON.stringify(scheduleEntries));
  dbNodeEntries = JSON.parse(JSON.stringify(nodeEntries));
  renderSchedulePlan();
}

function discardSchedule() {
  scheduleEntries = JSON.parse(JSON.stringify(dbEntries));
  nodeEntries = JSON.parse(JSON.stringify(dbNodeEntries));
}

function toggleSchedDatePicker(taskId, rowEl) {
  const existing = rowEl.parentElement.querySelector('.sched-date-picker');
  if (existing) { existing.remove(); return; }

  const entry = scheduleEntries[taskId];
  const picker = document.createElement('div');
  picker.className = 'sched-date-picker';
  picker.innerHTML = `
    <span style="color:var(--text-dim)">排期：</span>
    <input type="date" id="sched-date-start-${taskId}" value="${entry?.date_start || ''}">
    <span style="color:var(--text-dim)">–</span>
    <input type="date" id="sched-date-end-${taskId}" value="${entry?.date_end || ''}">
    <button class="sched-date-confirm" onclick="confirmSchedDate(${taskId})">确定</button>
    <button class="sched-date-cancel" onclick="clearSchedDate(${taskId})">清除</button>
    <button class="sched-date-cancel" onclick="this.closest('.sched-date-picker').remove()">取消</button>
  `;
  rowEl.insertAdjacentElement('afterend', picker);
}

async function confirmSchedDate(taskId) {
  const start = document.getElementById(`sched-date-start-${taskId}`).value;
  const end   = document.getElementById(`sched-date-end-${taskId}`).value;
  if (!start || !end) { alert('请填写开始和结束日期'); return; }
  if (start > end) { alert('开始日期不能晚于结束日期'); return; }
  scheduleEntries[taskId] = { is_current: 0, date_start: start, date_end: end };
  document.querySelector('.sched-date-picker')?.remove();
  renderSchedulePlan();
}

function clearSchedDate(taskId) {
  delete scheduleEntries[taskId];
  document.querySelector('.sched-date-picker')?.remove();
  renderSchedulePlan();
}

async function handleSchedTaskClick(task, taskById) {
  const entry = scheduleEntries[task.id];
  const effective = getEffectiveEntry(task, taskById);

  if (!effective) {
    scheduleEntries[task.id] = { is_current: 1, date_start: null, date_end: null };
  } else if (effective.inherited) {
    if (!effective.is_current) {
      scheduleEntries[task.id] = { is_current: 1, date_start: null, date_end: null };
    }
  } else if (entry) {
    if (entry.is_current) {
      delete scheduleEntries[task.id];
    }
  }
  renderSchedulePlan();
}

function makeSchedTaskRow(task, wi, taskById) {
  const entry     = scheduleEntries[task.id];
  const effective = getEffectiveEntry(task, taskById);

  let stateClass = 'state-unscheduled';
  let chipHtml   = '';
  if (task.status === 'archived') {
    stateClass = 'state-archived';
    chipHtml = '<span class="sched-chip chip-archived">已归档</span>';
  } else if (task.status === 'done') {
    stateClass = 'state-done';
    chipHtml = '<span class="sched-chip chip-done">已完成</span>';
  } else if (effective) {
    if (effective.is_current) {
      stateClass = effective.inherited ? 'state-current-inh' : 'state-current';
      chipHtml = `<span class="sched-chip chip-current">当前${effective.inherited ? '（继承）' : ''}</span>`;
    } else {
      stateClass = effective.inherited ? 'state-future-inh' : 'state-future';
      const label = `${effective.date_start?.slice(5)} – ${effective.date_end?.slice(5)}${effective.inherited ? '（继承）' : ''}`;
      chipHtml = `<span class="sched-chip chip-future">${label}</span>`;
    }
  }

  const row = document.createElement('div');
  row.className = `sched-task-row ${stateClass}`;
  row.dataset.taskId = task.id;

  // Workflow nodes expand button — leftmost
  const nodes = task.workflow_nodes || [];
  let expandBtn = null;
  let panel = null;
  if (nodes.length > 0) {
    expandBtn = document.createElement('button');
    expandBtn.className = 'sched-task-btn btn-expand';
    expandBtn.textContent = '▸';
    expandBtn.title = `节点任务 (${nodes.length})`;
    row.appendChild(expandBtn);
  }

  const titleEl = document.createElement('span');
  titleEl.className = 'sched-task-title';
  titleEl.textContent = task.title;
  titleEl.title = '双击编辑';
  titleEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startEditTaskTitle(titleEl, task); });
  row.appendChild(titleEl);

  if (chipHtml) row.insertAdjacentHTML('beforeend', chipHtml);

  const editLink = document.createElement('a');
  editLink.className = 'sched-edit-link';
  editLink.textContent = '编辑↗';
  editLink.href = '#';
  editLink.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    showView('work_items', null);
    setTimeout(() => {
      const target = document.querySelector(`.wi-view-block[data-wi-id="${wi.id}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
  };
  row.appendChild(editLink);

  if (task.status !== 'done' && task.status !== 'archived') {
    const calBtn = document.createElement('button');
    calBtn.className = 'sched-task-btn';
    calBtn.textContent = '📅';
    calBtn.title = '设置日期范围';
    calBtn.onclick = (e) => { e.stopPropagation(); toggleSchedDatePicker(task.id, row); };
    row.appendChild(calBtn);
  }

  if (task.status === 'archived') {
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'sched-task-btn btn-done';
    restoreBtn.title = '恢复';
    restoreBtn.textContent = '↩';
    restoreBtn.onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/task/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'todo' }),
      });
      task.status = 'todo';
      renderSchedulePlan();
    };
    row.appendChild(restoreBtn);
  } else {
    const doneBtn = document.createElement('button');
    doneBtn.className = 'sched-task-btn btn-done';
    doneBtn.title = task.status === 'done' ? '↩ 恢复' : '完成';
    doneBtn.textContent = task.status === 'done' ? '↩' : '✓';
    doneBtn.onclick = async (e) => {
      e.stopPropagation();
      const newStatus = task.status === 'done' ? 'todo' : 'done';
      await fetch(`/api/task/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      task.status = newStatus;
      renderSchedulePlan();
    };
    row.appendChild(doneBtn);

    if (task.status !== 'done') {
      const archBtn = document.createElement('button');
      archBtn.className = 'sched-task-btn btn-archive';
      archBtn.title = '归档（从所有视图隐藏）';
      archBtn.textContent = '⊘';
      archBtn.onclick = async (e) => {
        e.stopPropagation();
        await fetch(`/api/task/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'archived' }),
        });
        task.status = 'archived';
        renderSchedulePlan();
      };
      row.appendChild(archBtn);
    }
  }

  row.addEventListener('click', (e) => {
    if (e.target.closest('.sched-task-btn') || e.target.closest('.sched-edit-link')) return;
    if (task.status === 'archived') return;
    handleSchedTaskClick(task, taskById);
  });

  if (expandBtn) {
    panel = _makeSchedNodePanel(nodes, effective);
    const isOpen = expandedTaskIds.has(task.id);
    panel.style.display = isOpen ? '' : 'none';
    expandBtn.textContent = isOpen ? '▾' : '▸';
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      const hidden = panel.style.display === 'none';
      panel.style.display = hidden ? '' : 'none';
      expandBtn.textContent = hidden ? '▾' : '▸';
      if (hidden) expandedTaskIds.add(task.id);
      else expandedTaskIds.delete(task.id);
    };
    const wrapper = document.createElement('div');
    wrapper.appendChild(row);
    wrapper.appendChild(panel);
    return wrapper;
  }

  return row;
}

function _makeSchedNodePanel(nodes, parentEffective, plain = false) {
  const panel = document.createElement('div');
  panel.className = 'sched-node-panel';
  const statusColor = { todo: '#30363d', in_progress: '#58a6ff', done: '#3fb950', kept: '#3fb950', skipped: '#6e7681' };
  const statusLabel = { todo: '待做', in_progress: '进行中', done: '完成', kept: '保留', skipped: '跳过' };

  function appendNode(container, node, depth) {
    const nodeEntry = nodeEntries[node.id] || null;
    const effective = nodeEntry
      ? { ...nodeEntry, inherited: false }
      : (parentEffective ? { ...parentEffective, inherited: true } : null);

    let nodeStateClass = '';
    if (node.status === 'done' || node.status === 'kept') {
      nodeStateClass = 'node-done';
    } else if (node.status === 'skipped') {
      nodeStateClass = 'node-skipped';
    } else if (!plain && effective) {
      nodeStateClass = effective.is_current ? 'node-current' : 'node-future';
    }

    const row = document.createElement('div');
    row.className = `sched-node-row ${nodeStateClass}`;
    row.style.paddingLeft = `${depth * 14 + 8}px`;

    const dot = document.createElement('span');
    dot.className = 'sched-node-dot';
    dot.style.background = statusColor[node.status] || '#30363d';
    row.appendChild(dot);

    const title = document.createElement('span');
    title.className = 'sched-node-title';
    title.textContent = node.title;
    row.appendChild(title);

    const statusEl = document.createElement('span');
    statusEl.className = 'sched-node-status';
    statusEl.textContent = statusLabel[node.status] || node.status;
    row.appendChild(statusEl);

    if (!plain && node.status !== 'done' && node.status !== 'kept' && node.status !== 'skipped') {
      const calBtn = document.createElement('button');
      calBtn.className = 'sched-task-btn';
      calBtn.textContent = '📅';
      calBtn.title = '单独排期（覆盖继承）';
      calBtn.onclick = (e) => { e.stopPropagation(); toggleNodeDatePicker(node.id, row); };
      row.appendChild(calBtn);

      if (nodeEntry) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'sched-task-btn';
        clearBtn.textContent = '×';
        clearBtn.title = '清除单独排期（恢复继承）';
        clearBtn.onclick = async (e) => {
          e.stopPropagation();
          delete nodeEntries[node.id];
          renderSchedulePlan();
        };
        row.appendChild(clearBtn);
      }

      row.addEventListener('click', (e) => {
        if (e.target.closest('.sched-task-btn')) return;
        handleNodeClick(node, effective, nodeEntry);
      });
    }

    container.appendChild(row);
    nodes.filter(n => n.parent_node_id === node.id)
         .forEach(child => appendNode(container, child, depth + 1));
  }

  nodes.filter(n => !n.parent_node_id).forEach(n => appendNode(panel, n, 0));
  return panel;
}

function toggleNodeDatePicker(nodeId, rowEl) {
  const existing = rowEl.parentElement?.querySelector(`.sched-date-picker[data-node-id="${nodeId}"]`);
  if (existing) { existing.remove(); return; }

  const entry = nodeEntries[nodeId];
  const picker = document.createElement('div');
  picker.className = 'sched-date-picker';
  picker.dataset.nodeId = nodeId;
  picker.innerHTML = `
    <span style="color:var(--text-dim)">节点排期：</span>
    <input type="date" id="node-date-start-${nodeId}" value="${entry?.date_start || ''}">
    <span style="color:var(--text-dim)">–</span>
    <input type="date" id="node-date-end-${nodeId}" value="${entry?.date_end || ''}">
    <button class="sched-date-confirm" onclick="confirmNodeDate(${nodeId})">确定</button>
    <button class="sched-date-cancel" onclick="clearNodeDate(${nodeId})">清除</button>
    <button class="sched-date-cancel" onclick="this.closest('.sched-date-picker').remove()">取消</button>
  `;
  rowEl.insertAdjacentElement('afterend', picker);
}

async function confirmNodeDate(nodeId) {
  const start = document.getElementById(`node-date-start-${nodeId}`).value;
  const end   = document.getElementById(`node-date-end-${nodeId}`).value;
  if (!start || !end) { alert('请填写开始和结束日期'); return; }
  if (start > end) { alert('开始日期不能晚于结束日期'); return; }
  nodeEntries[nodeId] = { is_current: 0, date_start: start, date_end: end };
  document.querySelector(`.sched-date-picker[data-node-id="${nodeId}"]`)?.remove();
  renderSchedulePlan();
}

function clearNodeDate(nodeId) {
  delete nodeEntries[nodeId];
  document.querySelector(`.sched-date-picker[data-node-id="${nodeId}"]`)?.remove();
  renderSchedulePlan();
}

async function handleNodeClick(node, effective, nodeEntry) {
  if (!effective) {
    nodeEntries[node.id] = { is_current: 1, date_start: null, date_end: null };
    renderSchedulePlan();
  } else if (effective.inherited) {
    if (!effective.is_current) {
      nodeEntries[node.id] = { is_current: 1, date_start: null, date_end: null };
      renderSchedulePlan();
    }
  } else if (nodeEntry && nodeEntry.is_current) {
    delete nodeEntries[node.id];
    renderSchedulePlan();
  }
}

function _makeSchedWiBlock(wi, idx) {
  const taskById = Object.fromEntries(wi.tasks.map(t => [t.id, t]));

  const hasVisible = wi.tasks.some(t => filterTaskForSchedView(t, taskById));
  if (!hasVisible) return null;

  const childrenOf = {};
  wi.tasks.forEach(t => {
    if (t.parent_task_id) {
      (childrenOf[t.parent_task_id] = childrenOf[t.parent_task_id] || []).push(t);
    }
  });

  // Recursive helper: renders children of parentId into container
  function appendChildren(container, parentId) {
    const children = (childrenOf[parentId] || []).filter(c => filterTaskForSchedView(c, taskById));
    if (children.length === 0) return;
    const wrap = document.createElement('div');
    wrap.className = 'sched-child-wrap';
    children.forEach(child => {
      wrap.appendChild(makeSchedTaskRow(child, wi, taskById));
      appendChildren(wrap, child.id);
    });
    container.appendChild(wrap);
  }

  const block = document.createElement('div');
  block.className = 'wi-view-block';
  block.dataset.wiId = wi.id;

  const header = document.createElement('div');
  header.className = `wi-view-header ${wi.score >= 20 ? 'priority-high' : ''}`;
  const idxSpan = document.createElement('span'); idxSpan.className = 'wiv-idx'; idxSpan.textContent = `${idx + 1}.`;
  const typeSpan = document.createElement('span'); typeSpan.className = 'wiv-type'; typeSpan.textContent = wi.type;
  const titleSpan = document.createElement('span'); titleSpan.className = 'wiv-title'; titleSpan.textContent = wi.title;
  titleSpan.title = '双击编辑'; titleSpan.style.cursor = 'text';
  titleSpan.addEventListener('dblclick', (e) => { e.stopPropagation(); startEditWiTitle(titleSpan, wi); });
  const scoreSpan = document.createElement('span'); scoreSpan.className = 'wiv-score'; scoreSpan.textContent = `重${wi.importance} 急${wi.urgency}`;
  header.appendChild(idxSpan); header.appendChild(typeSpan); header.appendChild(titleSpan); header.appendChild(scoreSpan);
  header.addEventListener('click', () => {
    const body = block.querySelector('.sched-wi-body');
    if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
  });
  block.appendChild(header);

  const body = document.createElement('div');
  body.className = 'sched-wi-body';
  body.style.paddingLeft = '16px';
  body.style.paddingTop = '6px';

  wi.tasks.forEach(task => {
    if (task.parent_task_id) return;
    const taskVisible = filterTaskForSchedView(task, taskById);
    const hasVisibleDescendant = (function hasDesc(id) {
      return (childrenOf[id] || []).some(c => filterTaskForSchedView(c, taskById) || hasDesc(c.id));
    })(task.id);
    if (!taskVisible && !hasVisibleDescendant) return;
    if (taskVisible) body.appendChild(makeSchedTaskRow(task, wi, taskById));
    appendChildren(body, task.id);
  });

  block.appendChild(body);
  return block;
}

function renderSchedulePlan() {
  const container = document.getElementById('schedule');
  container.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'sched-toolbar';
  const unsaved = hasUnsavedSchedule();
  toolbar.innerHTML = `
    <button class="sched-layout-btn${schedPlanLayout === 'single' ? ' active' : ''}" onclick="setSchedLayout('single')">单列</button>
    <button class="sched-layout-btn${schedPlanLayout === 'double' ? ' active' : ''}" onclick="setSchedLayout('double')">双列</button>
    <div class="sched-toolbar-sep"></div>
    <button class="sched-filter-btn${schedPlanFilter === 'all'      ? ' active' : ''}" onclick="setSchedFilter('all')">所有任务</button>
    <button class="sched-filter-btn${schedPlanFilter === 'active'   ? ' active' : ''}" onclick="setSchedFilter('active')">活跃任务</button>
    <button class="sched-filter-btn${schedPlanFilter === 'current'  ? ' active' : ''}" onclick="setSchedFilter('current')">当前任务</button>
    <button class="sched-filter-btn${schedPlanFilter === 'upcoming' ? ' active' : ''}" onclick="setSchedFilter('upcoming')">近期任务</button>
    <div class="sched-toolbar-spacer"></div>
    <button class="sched-action-btn sched-goto-wi" onclick="showView('work_items', null)">编辑任务</button>
    <button class="sched-action-btn sched-save-btn${unsaved ? ' has-changes' : ''}" onclick="saveSchedule()">保存排期</button>
  `;
  container.appendChild(toolbar);

  if (scheduleData.length === 0) {
    container.insertAdjacentHTML('beforeend', '<p style="color:#8b949e;padding:16px">暂无活跃支线</p>');
    return;
  }

  if (schedPlanLayout === 'double') {
    const projectItems = scheduleData.filter(w => w.type === 'project');
    const otherItems   = scheduleData.filter(w => w.type !== 'project');

    const twoCol = document.createElement('div');
    twoCol.className = 'wi-two-col';

    const leftCol = document.createElement('div');
    leftCol.className = 'wi-col';
    leftCol.insertAdjacentHTML('beforeend', '<div class="wi-col-label">研究项目</div>');
    projectItems.forEach((wi, i) => {
      const block = _makeSchedWiBlock(wi, i);
      if (block) leftCol.appendChild(block);
    });

    const rightCol = document.createElement('div');
    rightCol.className = 'wi-col';
    rightCol.insertAdjacentHTML('beforeend', '<div class="wi-col-label">论文 · 教学 · 其他</div>');
    otherItems.forEach((wi, i) => {
      const block = _makeSchedWiBlock(wi, i);
      if (block) rightCol.appendChild(block);
    });

    twoCol.appendChild(leftCol);
    twoCol.appendChild(rightCol);
    container.appendChild(twoCol);
  } else {
    let globalIdx = 0;
    scheduleData.forEach(wi => {
      const block = _makeSchedWiBlock(wi, globalIdx);
      if (block) { container.appendChild(block); globalIdx++; }
    });
  }
  scanForDuplicates();
}

function _makeWiBlock(wi, idx) {
  const block = document.createElement('div');
  block.className = 'wi-view-block';
  block.dataset.wiId = wi.id;

  const header = document.createElement('div');
  header.className = `wi-view-header ${wi.score >= 20 ? 'priority-high' : ''}`;
  const dragHandle = document.createElement('span'); dragHandle.className = 'wi-view-wi-drag-handle'; dragHandle.title = '拖动排序'; dragHandle.textContent = '⠿';
  const idxSpan2 = document.createElement('span'); idxSpan2.className = 'wiv-idx'; idxSpan2.textContent = `${idx + 1}.`;
  const typeSpan2 = document.createElement('span'); typeSpan2.className = 'wiv-type'; typeSpan2.textContent = wi.type;
  const titleSpan2 = document.createElement('span'); titleSpan2.className = 'wiv-title'; titleSpan2.textContent = wi.title;
  titleSpan2.title = '双击编辑'; titleSpan2.style.cursor = 'text';
  titleSpan2.addEventListener('dblclick', (e) => { e.stopPropagation(); startEditWiTitle(titleSpan2, wi); });
  const scoreEl = document.createElement('span'); scoreEl.className = 'wiv-score'; scoreEl.textContent = `重${wi.importance} 急${wi.urgency}`;
  scoreEl.title = '点击编辑重要/紧急'; scoreEl.style.cursor = 'pointer';
  scoreEl.addEventListener('click', (e) => { e.stopPropagation(); startEditWiScore(scoreEl, wi); });
  header.appendChild(dragHandle); header.appendChild(idxSpan2); header.appendChild(typeSpan2); header.appendChild(titleSpan2); header.appendChild(scoreEl);
  header.addEventListener('click', (e) => {
    if (e.target.closest('.wi-view-wi-drag-handle')) return;
    if (e.target.closest('.wiv-score')) return;
    const tasks = block.querySelector('.wi-view-tasks');
    if (tasks) tasks.style.display = tasks.style.display === 'none' ? '' : 'none';
  });
  block.appendChild(header);

  const prog = wi.workflow_progress || {done: 0, total: 0};
  if (prog.total > 0) {
    const barWrap = document.createElement('div');
    barWrap.className = 'wi-progress-bar-wrap';
    barWrap.title = `${prog.done} / ${prog.total} 节点完成`;
    const fill = document.createElement('div');
    fill.className = 'wi-progress-bar-fill';
    fill.style.width = `${Math.round(prog.done / prog.total * 100)}%`;
    barWrap.appendChild(fill);
    block.appendChild(barWrap);
  }

  const wiTaskById = Object.fromEntries(wi.tasks.map(t => [t.id, t]));

  const taskList = document.createElement('div');
  taskList.className = 'wi-view-tasks';
  wi.tasks.forEach(task => taskList.appendChild(makeWiViewTaskRow(task, wi, wiTaskById)));

  // "+ 新建任务" inline row
  const addTaskRow = document.createElement('div');
  addTaskRow.className = 'wi-add-task-row';
  addTaskRow.innerHTML = `<span class="wi-add-task-btn">+ 新建任务</span>`;
  addTaskRow.querySelector('.wi-add-task-btn').addEventListener('click', () => quickAddTask(wi.id, taskList, wi));
  taskList.appendChild(addTaskRow);

  block.appendChild(taskList);

  new Sortable(taskList, {
    handle: '.wi-view-drag-handle',
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd() {
      const prevOrder = wi.tasks.map(t => t.id);
      const rows = [...taskList.querySelectorAll('.wi-view-task-row')];
      const newOrder = rows.map(r => parseInt(r.dataset.taskId));
      pushUndo({ type: 'reorder_tasks', prevOrder, wiId: wi.id });
      newOrder.forEach((taskId, i) => {
        fetch(`/api/task/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ priority: i }),
        });
      });
      const taskMap = Object.fromEntries(wi.tasks.map(t => [t.id, t]));
      wi.tasks = newOrder.map(id => taskMap[id]);
    },
  });

  return block;
}

function _attachWiSortable(colEl, group) {
  new Sortable(colEl, {
    handle: '.wi-view-wi-drag-handle',
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd() {
      const prevOrder = scheduleData.map(w => w.id);
      const blocks = [...colEl.querySelectorAll('.wi-view-block')];
      const newOrder = blocks.map(b => parseInt(b.dataset.wiId));
      pushUndo({ type: 'reorder_work_items', prevOrder });
      newOrder.forEach((wiId, i) => {
        fetch(`/api/work_item/${wiId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sort_order: i }),
        });
      });
      // Rebuild scheduleData: new order for this group, keep other group in place
      const wiMap = Object.fromEntries(scheduleData.map(w => [w.id, w]));
      const otherItems = scheduleData.filter(w => !newOrder.includes(w.id));
      const reordered = newOrder.map(id => wiMap[id]);
      if (group === 'project') {
        scheduleData = [...reordered, ...otherItems];
      } else {
        scheduleData = [...otherItems, ...reordered];
      }
      blocks.forEach((b, i) => {
        const idxEl = b.querySelector('.wiv-idx');
        if (idxEl) idxEl.textContent = `${i + 1}.`;
      });
    },
  });
}

function renderWorkItems() {
  const container = document.getElementById('work-items');
  container.innerHTML = '';

  // Layout toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'wi-layout-toolbar';
  toolbar.innerHTML = `
    <button class="wi-layout-btn${wiViewLayout === 'single' ? ' active' : ''}" onclick="setWiLayout('single')">单列</button>
    <button class="wi-layout-btn${wiViewLayout === 'double' ? ' active' : ''}" onclick="setWiLayout('double')">双列</button>
    <button class="wi-layout-btn" onclick="quickAddWorkItem()" style="margin-left:auto">+ 新建支线</button>
    <a class="wi-layout-btn" href="/api/export/csv" download title="导出所有数据为 CSV (ZIP)">⬇ 备份导出</a>
  `;
  container.appendChild(toolbar);

  if (scheduleData.length === 0) {
    container.insertAdjacentHTML('beforeend', '<p style="color:#8b949e;padding:16px">暂无支线</p>');
    return;
  }

  if (wiViewLayout === 'double') {
    const projectItems = scheduleData.filter(w => w.type === 'project');
    const otherItems = scheduleData.filter(w => w.type !== 'project');

    const twoCol = document.createElement('div');
    twoCol.className = 'wi-two-col';

    const leftCol = document.createElement('div');
    leftCol.className = 'wi-col';
    const leftLabel = document.createElement('div');
    leftLabel.className = 'wi-col-label';
    leftLabel.textContent = '研究项目';
    leftCol.appendChild(leftLabel);
    projectItems.forEach((wi, i) => leftCol.appendChild(_makeWiBlock(wi, i)));
    _attachWiSortable(leftCol, 'project');

    const rightCol = document.createElement('div');
    rightCol.className = 'wi-col';
    const rightLabel = document.createElement('div');
    rightLabel.className = 'wi-col-label';
    rightLabel.textContent = '论文 · 教学 · 其他';
    rightCol.appendChild(rightLabel);
    otherItems.forEach((wi, i) => rightCol.appendChild(_makeWiBlock(wi, i)));
    _attachWiSortable(rightCol, 'other');

    twoCol.appendChild(leftCol);
    twoCol.appendChild(rightCol);
    container.appendChild(twoCol);
  } else {
    scheduleData.forEach((wi, idx) => container.appendChild(_makeWiBlock(wi, idx)));

    new Sortable(container, {
      handle: '.wi-view-wi-drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      filter: '.wi-layout-toolbar',
      onEnd() {
        const prevOrder = scheduleData.map(w => w.id);
        const blocks = [...container.querySelectorAll(':scope > .wi-view-block')];
        const newOrder = blocks.map(b => parseInt(b.dataset.wiId));
        if (newOrder.join() === prevOrder.join()) return;
        pushUndo({ type: 'reorder_work_items', prevOrder });
        newOrder.forEach((wiId, i) => {
          fetch(`/api/work_item/${wiId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sort_order: i }),
          });
        });
        const wiMap = Object.fromEntries(scheduleData.map(w => [w.id, w]));
        scheduleData = newOrder.map(id => wiMap[id]);
        blocks.forEach((b, i) => {
          const idxEl = b.querySelector('.wiv-idx');
          if (idxEl) idxEl.textContent = `${i + 1}.`;
        });
      },
    });
  }
}

function makeWiViewTaskRow(task, wi, taskById = {}) {
  const nodes = task.workflow_nodes || [];
  const hasSubContent = nodes.length > 0;

  const row = document.createElement('div');
  row.className = 'wi-view-task-row';
  row.dataset.taskId = task.id;

  // Expand button — replaces the ::before tree connector for rows with nodes
  let expandBtn = null;
  let nodePanel = null;
  // Always render a fixed-width connector element so all rows align
  if (hasSubContent) {
    expandBtn = document.createElement('button');
    expandBtn.className = 'wi-tree-connector';
    expandBtn.textContent = '|+- ';
    expandBtn.title = `展开工作流节点 (${nodes.length})`;
    row.appendChild(expandBtn);
  } else {
    const connector = document.createElement('span');
    connector.className = 'wi-tree-connector';
    connector.textContent = '|-- ';
    row.appendChild(connector);
  }

  const handle = document.createElement('span');
  handle.className = 'wi-view-drag-handle';
  handle.textContent = '⠿';
  handle.title = '拖动排序';
  row.appendChild(handle);

  const titleEl = document.createElement('span');
  titleEl.className = 'wi-view-task-title';
  titleEl.textContent = task.title;
  titleEl.title = '双击编辑';
  titleEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startEditTaskTitle(titleEl, task); });
  row.appendChild(titleEl);

  if (visibleTags.includes('executor')) {
    const assignments = (task.assignments || []).filter(a => a.person_name);
    if (assignments.length) {
      const wrap = document.createElement('span');
      wrap.className = 'task-assignees';
      assignments.forEach(a => {
        const span = document.createElement('span');
        const isExtra = a.role_in_task !== 'executor';
        span.className = 'task-tag executor clickable-person' + (isExtra ? ' extra-person' : '');
        span.textContent = a.person_name;
        span.addEventListener('click', (e) => { e.stopPropagation(); openPersonCard(span, a.person_name, task.id); });
        wrap.appendChild(span);
      });
      row.appendChild(wrap);
    }
  }
  if (visibleTags.includes('deadline') && task.due_date) {
    const tag = document.createElement('span');
    tag.className = 'task-tag deadline';
    tag.textContent = `due:${task.due_date}`;
    row.appendChild(tag);
  }
  if (visibleTags.includes('score') && task.score != null) {
    const tag = document.createElement('span');
    tag.className = 'task-tag score';
    tag.textContent = `★${task.score}`;
    row.appendChild(tag);
  }
  if (visibleTags.includes('importance')) {
    const tag = document.createElement('span');
    tag.className = 'task-tag';
    tag.textContent = `重要${wi.importance}`;
    row.appendChild(tag);
  }
  if (visibleTags.includes('urgency')) {
    const tag = document.createElement('span');
    tag.className = 'task-tag';
    tag.textContent = `紧急${wi.urgency}`;
    row.appendChild(tag);
  }

  const editBtn = document.createElement('button');
  editBtn.className = 'wi-edit-btn';
  editBtn.textContent = '✏';
  editBtn.title = '编辑任务';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openTaskEditModal(task, wi);
  });
  row.appendChild(editBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn-workflow-toggle';
  toggleBtn.textContent = '⚙ 工作流';
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openWorkflowPanel(task, wi, row);
  });
  row.appendChild(toggleBtn);

  if (expandBtn) {
    const effective = getEffectiveEntry(task, taskById);
    nodePanel = _makeSchedNodePanel(nodes, effective, true);
    nodePanel.style.display = 'none';
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      const hidden = nodePanel.style.display === 'none';
      nodePanel.style.display = hidden ? '' : 'none';
      expandBtn.textContent = hidden ? '|-▾ ' : '|+- ';
    };
    const wrapper = document.createElement('div');
    wrapper.appendChild(row);
    wrapper.appendChild(nodePanel);
    return wrapper;
  }

  return row;
}

// ── Person card popover (click name in task row) ───────────────────────────

let _personCardPopover = null;
let _personCardHandler = null;

function _closePersonCard() {
  if (_personCardHandler) { document.removeEventListener('click', _personCardHandler); _personCardHandler = null; }
  if (_personCardPopover) { _personCardPopover.remove(); _personCardPopover = null; }
}

async function openPersonCard(anchorEl, personName, taskId) {
  _closePersonCard();

  // Use cached scheduleData; fetch people fresh
  const peopleResp = await fetch('/api/people');
  const allPeople = (await peopleResp.json()).people;
  const person = allPeople.find(p => p.name === personName) || null;

  // Find task assignments from cached scheduleData
  let taskAssignments = [];
  for (const wi of scheduleData) {
    const t = (wi.tasks || []).find(t => t.id === taskId);
    if (t) { taskAssignments = t.assignments || []; break; }
  }

  const pop = document.createElement('div');
  pop.className = 'person-card-pop';

  // Person info section
  let infoHtml = '';
  if (person) {
    const roleLabel = { undergraduate:'本科生', master:'硕士', phd:'博士', collaborator_teacher:'老师', clinician:'医生', peer:'同行', other:'其他' };
    const bw = Math.min((person.scheduled_count || 0) * 25, 100);
    const bars = '█'.repeat(Math.round(bw/10)) + '░'.repeat(10 - Math.round(bw/10));
    infoHtml = `
      <div class="pcp-name">${esc(person.name)}</div>
      <div class="pcp-detail">角色: ${roleLabel[person.role] || person.role}</div>
      ${person.expertise ? `<div class="pcp-detail">专长: ${esc(person.expertise)}</div>` : ''}
      <div class="pcp-detail">带宽: ${bw}% <span style="font-family:monospace;font-size:10px;color:#3fb950">${bars}</span></div>
      <div class="pcp-detail">任务: ${person.task_count} 个</div>
    `;
  } else {
    infoHtml = `<div class="pcp-name">${esc(personName)}</div><div class="pcp-detail" style="color:#8b949e">（未在人员库中）</div>`;
  }

  // Current assignees on this task (excluding the clicked person)
  const others = taskAssignments.filter(a => a.person_name !== personName);
  const othersHtml = others.length
    ? others.map(a => `<span class="pcp-assignee">${esc(a.person_name || '本人')}</span>`).join('')
    : '';

  // People picker options (exclude already assigned)
  const assignedNames = new Set(taskAssignments.map(a => a.person_name));
  const pickable = allPeople.filter(p => !assignedNames.has(p.name));
  const pickOpts = pickable.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');

  pop.innerHTML = `
    <div class="pcp-info">${infoHtml}</div>
    ${others.length ? `<div class="pcp-section-label">同任务人员</div><div class="pcp-assignees">${othersHtml}</div>` : ''}
    <div class="pcp-section-label">添加相关人</div>
    <div class="pcp-add-row">
      <input type="text" class="pcp-name-input" placeholder="姓名…" list="pcp-datalist" autocomplete="off">
      <datalist id="pcp-datalist">${pickOpts}</datalist>
      <select class="pcp-role-sel">
        <option value="executor">执行人</option>
        <option value="stakeholder">合作者</option>
        <option value="owner">负责人</option>
      </select>
      <button class="pcp-add-btn">+</button>
    </div>
    <div class="pcp-new-people"></div>
  `;

  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  pop.style.left = (rect.left + window.scrollX) + 'px';
  _personCardPopover = pop;

  // Track newly added people in this session
  const newlyAdded = [];

  pop.querySelector('.pcp-add-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const nameInput = pop.querySelector('.pcp-name-input');
    const roleSel = pop.querySelector('.pcp-role-sel');
    const name = nameInput.value.trim();
    if (!name) return;
    const role = roleSel.value;

    // If not in DB, create them
    const existing = allPeople.find(p => p.name === name);
    if (!existing) {
      const r = await fetch('/api/people', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role: 'other', expertise: '' }),
      });
      if (!r.ok) { alert('新建人员失败'); return; }
    }

    // Add assignment to task
    const r2 = await fetch(`/api/task/${taskId}/assignment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person_name: name, role }),
    });
    if (!r2.ok) { alert('添加失败'); return; }

    newlyAdded.push(name);
    nameInput.value = '';

    // Show in new-people area
    const newArea = pop.querySelector('.pcp-new-people');
    const chip = document.createElement('span');
    chip.className = 'pcp-assignee new';
    chip.textContent = name;
    newArea.appendChild(chip);

    // Refresh schedule data so task rows update
    await loadData();
    _refreshTaskAssignees(taskId);
  });

  setTimeout(() => {
    _personCardHandler = (e) => {
      if (!pop.contains(e.target) && e.target !== anchorEl) _closePersonCard();
    };
    document.addEventListener('click', _personCardHandler);
  }, 0);
}

function _refreshTaskAssignees(taskId) {
  // Re-render all executor tags for this task across the visible DOM
  document.querySelectorAll(`.task-row[data-task-id="${taskId}"] .task-assignees`).forEach(el => {
    const task = scheduleData.flatMap(wi => wi.tasks).find(t => t.id === taskId);
    if (!task) return;
    el.innerHTML = '';
    _appendAssigneeTags(el, task, taskId);
  });
}

function _appendAssigneeTags(container, task, taskId) {
  (task.assignments || []).forEach(a => {
    const span = document.createElement('span');
    span.className = 'task-tag executor clickable-person';
    span.textContent = a.person_name || '本人';
    span.addEventListener('click', (e) => { e.stopPropagation(); openPersonCard(span, a.person_name || '本人', taskId); });
    container.appendChild(span);
  });
}



const ROLE_LABELS = { executor: '执行人', stakeholder: '合作者', owner: '负责人' };

async function openTaskEditModal(task, wi) {
  _taskEditState = {
    task,
    wi,
    initialAssignments: (task.assignments || []).map(a => ({ ...a })),
    currentAssignments: (task.assignments || []).map(a => ({ ...a })),
  };

  document.getElementById('task-edit-title').value = task.title || '';
  document.getElementById('task-edit-wi-name').textContent = wi.title || '';
  document.getElementById('task-edit-status').value = task.status || 'todo';
  document.getElementById('task-edit-due').value = task.due_date || '';
  document.getElementById('task-edit-new-name').value = '';
  document.getElementById('task-edit-add-btn').disabled = true;

  _renderPeopleList();

  // Populate datalist (fetch once per session)
  if (!_peopleCache) {
    try {
      const resp = await fetch('/api/people');
      const data = await resp.json();
      _peopleCache = data.people || [];
    } catch (_) {
      // leave _peopleCache null so next open retries
    }
  }
  const dl = document.getElementById('task-edit-people-datalist');
  dl.innerHTML = '';
  _peopleCache.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    dl.appendChild(opt);
  });

  const overlay = document.getElementById('task-edit-modal-overlay');
  overlay.classList.add('visible');
  document.getElementById('task-edit-title').focus();
}

function _renderPeopleList() {
  const list = document.getElementById('task-edit-people-list');
  list.innerHTML = '';
  (_taskEditState.currentAssignments || []).forEach((a, idx) => {
    const row = document.createElement('div');
    row.className = 'task-edit-person-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'task-edit-person-name';
    nameEl.textContent = a.person_name || '（自己）';
    row.appendChild(nameEl);

    const roleSelect = document.createElement('select');
    ['executor', 'stakeholder', 'owner'].forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = ROLE_LABELS[r];
      if (r === a.role_in_task) opt.selected = true;
      roleSelect.appendChild(opt);
    });
    roleSelect.addEventListener('change', () => {
      _taskEditState.currentAssignments[idx].role_in_task = roleSelect.value;
    });
    row.appendChild(roleSelect);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'task-edit-person-remove';
    removeBtn.textContent = '×';
    removeBtn.title = '移除';
    removeBtn.addEventListener('click', () => {
      _taskEditState.currentAssignments.splice(idx, 1);
      _renderPeopleList();
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });
}

function taskEditAddPerson() {
  const nameInput = document.getElementById('task-edit-new-name');
  const roleSelect = document.getElementById('task-edit-new-role');
  const name = nameInput.value.trim();
  if (!name) return;
  _taskEditState.currentAssignments.push({
    person_id: null,
    person_name: name,
    role_in_task: roleSelect.value,
  });
  nameInput.value = '';
  document.getElementById('task-edit-add-btn').disabled = true;
  _renderPeopleList();
}

function closeTaskEditModal() {
  document.getElementById('task-edit-modal-overlay').classList.remove('visible');
  _taskEditState = null;
}

async function saveTaskEdit() {
  if (!_taskEditState) return;
  const { task, initialAssignments, currentAssignments } = _taskEditState;
  const saveBtn = document.getElementById('btn-task-edit-save');
  saveBtn.disabled = true;

  try {
    // 1. Build and send field patch
    const patch = {};
    const newTitle = document.getElementById('task-edit-title').value.trim();
    if (!newTitle) { alert('任务名称不能为空'); saveBtn.disabled = false; return; }
    const newStatus = document.getElementById('task-edit-status').value;
    const newDue = document.getElementById('task-edit-due').value || null;
    if (newTitle !== task.title) patch.title = newTitle;
    if (newStatus !== task.status) patch.status = newStatus;
    if (newDue !== (task.due_date || null)) patch.due_date = newDue;

    if (Object.keys(patch).length > 0) {
      const resp = await fetch(`/api/task/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || '保存失败');
      }
    }

    // 2. Compute assignment diff
    const key = a => `${a.person_name}|${a.role_in_task}`;
    const initialKeys = new Set(initialAssignments.map(key));
    const currentKeys = new Set(currentAssignments.map(key));

    const toAdd = currentAssignments.filter(a => !initialKeys.has(key(a)));
    const toRemove = initialAssignments.filter(a => !currentKeys.has(key(a)));

    for (const a of toAdd) {
      const resp = await fetch(`/api/task/${task.id}/assignment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_name: a.person_name, role: a.role_in_task }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || '添加人员失败');
      }
    }

    for (const a of toRemove) {
      if (a.person_id == null) continue; // self-assignment with no person_id, skip
      const resp = await fetch(`/api/task/${task.id}/assignment`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_id: a.person_id, role: a.role_in_task }),
      });
      if (!resp.ok && resp.status !== 404) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || '移除人员失败');
      }
    }

    closeTaskEditModal();
    const data = await fetch('/api/schedule').then(r => r.json());
    scheduleData = data.work_items;
    renderWorkItems();
  } catch (err) {
    alert('保存失败: ' + err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

// ── Workflow canvas ────────────────────────────────────────────────────────

function openWorkflowPanel(task, wi, taskRowEl) {
  if (window.openWorkflowCanvas) {
    window.openWorkflowCanvas(task.id, task.title, wi.title, taskRowEl);
  }
}

async function refreshProgress(wi, task) {
  // Refetch schedule data to get updated workflow_progress
  const resp = await fetch('/api/schedule');
  const data = await resp.json();
  scheduleData = data.work_items;

  // Update progress bar for this work item if visible
  const container = document.getElementById('work-items');
  if (!container || container.style.display === 'none') return;
  const wiBlock = [...container.querySelectorAll('.wi-view-block')]
    .find((_, i) => scheduleData[i]?.id === wi.id);
  if (!wiBlock) return;
  const updatedWi = scheduleData.find(w => w.id === wi.id);
  if (!updatedWi) return;
  const prog = updatedWi.workflow_progress || {done: 0, total: 0};
  wi.workflow_progress = prog;
  const fill = wiBlock.querySelector('.wi-progress-bar-fill');
  if (fill && prog.total > 0) {
    fill.style.width = `${Math.round(prog.done / prog.total * 100)}%`;
    fill.closest('.wi-progress-bar-wrap').title = `${prog.done} / ${prog.total} 节点完成`;
  } else if (!fill && prog.total > 0) {
    // Bar didn't exist before (no nodes), re-render block header area
    renderWorkItems();
  }
}

// ── Undo ───────────────────────────────────────────────────────────────────

// ── Input submission ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const inputText = document.getElementById('input-text');
  const btnSubmit = document.getElementById('btn-submit');

  if (inputText) {
    inputText.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); submitInput(); }
    });
  }
  if (btnSubmit) btnSubmit.onclick = submitInput;

  const btnConfirm = document.getElementById('btn-confirm');
  const btnCancel = document.getElementById('btn-cancel');
  if (btnConfirm) btnConfirm.onclick = confirmWrite;
  if (btnCancel) btnCancel.onclick = cancelConfirm;

  const btnOnboard = document.getElementById('btn-onboard');
  if (btnOnboard) btnOnboard.onclick = submitOnboarding;

  const btnSupplement = document.getElementById('btn-onboard-supplement');
  if (btnSupplement) btnSupplement.onclick = submitOnboardingSupplement;

  const btnOnboardConfirm = document.getElementById('btn-onboard-confirm');
  if (btnOnboardConfirm) btnOnboardConfirm.onclick = confirmOnboarding;

  // Task edit modal: enable/disable + button based on name input
  const taskEditNameInput = document.getElementById('task-edit-new-name');
  if (taskEditNameInput) {
    taskEditNameInput.addEventListener('input', () => {
      document.getElementById('task-edit-add-btn').disabled =
        taskEditNameInput.value.trim() === '';
    });
  }

  // Task edit modal: Escape key closes it
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const overlay = document.getElementById('task-edit-modal-overlay');
      if (overlay && overlay.classList.contains('visible')) closeTaskEditModal();
    }
  });

  // Task edit modal: click outside closes it
  const taskEditOverlay = document.getElementById('task-edit-modal-overlay');
  if (taskEditOverlay) {
    taskEditOverlay.addEventListener('click', e => {
      if (e.target === taskEditOverlay) closeTaskEditModal();
    });
  }
});

async function submitInput() {
  const inputText = document.getElementById('input-text');
  const text = inputText.value.trim();
  if (!text) return;

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const resp = await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if (data.error) { alert('解析出错: ' + data.error); return; }
    inputText.value = '';
    showConfirmPanel(data);
  } finally {
    btn.disabled = false;
    btn.textContent = '提交';
  }
}

function showConfirmPanel(result) {
  pendingResult = result;
  const panel = document.getElementById('confirm-panel');
  const changesEl = document.getElementById('confirm-changes');
  const questionsEl = document.getElementById('confirm-questions');
  const questionsWrap = document.getElementById('confirm-questions-wrap');

  changesEl.innerHTML = '';

  // Build editable table
  const table = document.createElement('table');
  table.className = 'confirm-table';
  table.innerHTML = `<thead><tr>
    <th>操作</th><th>支线</th><th>任务名称</th><th>执行人</th><th>合作者</th>
    <th>排期</th><th>重要</th><th>紧急</th><th>类型</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  const ACTION_LABEL = { add_task: '新增任务', update_task: '更新任务', add_work_item: '新增支线', update_work_item: '更新支线', add_stakeholder_note: '合作者备注' };

  result.changes.forEach((c, idx) => {
    const d = c.data;
    const tr = document.createElement('tr');
    tr.className = c.confirmed ? 'confirmed' : 'pending';
    tr.dataset.idx = idx;

    const cell = (val, field, type = 'text') => {
      const td = document.createElement('td');
      if (field === null) { td.textContent = val || ''; return td; }
      const inp = document.createElement('input');
      inp.type = type;
      inp.value = val || '';
      inp.dataset.field = field;
      inp.className = 'confirm-cell-input';
      if (field === 'executor_name' || field === 'stakeholder_names') {
        const dlId = `confirm-dl-${field}-${idx}`;
        inp.setAttribute('list', dlId);
        const dl = document.createElement('datalist');
        dl.id = dlId;
        (peopleData || []).forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.name;
          dl.appendChild(opt);
        });
        td.appendChild(dl);
      }
      td.appendChild(inp);
      return td;
    };

    if (c.action === 'add_task') {
      const OWNERSHIP_LABEL = { self_lead: '自主', delegated: '委派', supervised: '监督' };
      tr.appendChild(cell(ACTION_LABEL[c.action], null));
      tr.appendChild(cell(d.work_item_title, 'work_item_title'));
      tr.appendChild(cell(d.title, 'title'));
      tr.appendChild(cell(d.executor_name, 'executor_name'));
      tr.appendChild(cell((d.stakeholder_names || []).join(', '), 'stakeholder_names'));
      tr.appendChild(cell(d.due_date, 'due_date', 'date'));
      tr.appendChild(cell('', null));
      tr.appendChild(cell('', null));
      const ownerTd = document.createElement('td');
      const ownerSel = document.createElement('select');
      ownerSel.className = 'confirm-cell-input';
      ownerSel.dataset.field = 'ownership';
      [['self_lead','自主'],['delegated','委派'],['supervised','监督']].forEach(([v,l]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = l;
        if ((d.ownership || 'self_lead') === v) o.selected = true;
        ownerSel.appendChild(o);
      });
      ownerTd.appendChild(ownerSel);
      tr.appendChild(ownerTd);
    } else if (c.action === 'add_work_item') {
      tr.appendChild(cell(ACTION_LABEL[c.action], null));
      tr.appendChild(cell(d.title, 'title'));
      tr.appendChild(cell('', null)); // task name N/A
      tr.appendChild(cell('', null)); // executor N/A
      tr.appendChild(cell('', null)); // stakeholder N/A
      tr.appendChild(cell(d.deadline, 'deadline', 'date'));
      tr.appendChild(cell(String(d.importance ?? 3), 'importance', 'number'));
      tr.appendChild(cell(String(d.urgency ?? 3), 'urgency', 'number'));
      // Type select
      const typeTd = document.createElement('td');
      const typeSel = document.createElement('select');
      typeSel.className = 'confirm-cell-input';
      typeSel.dataset.field = 'type';
      [['project','项目'],['paper','论文'],['teaching','教学'],['learning','学习'],['routine','日常']].forEach(([v,l]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = l;
        if ((d.type || 'project') === v) o.selected = true;
        typeSel.appendChild(o);
      });
      typeTd.appendChild(typeSel);
      tr.appendChild(typeTd);
    } else if (c.action === 'add_stakeholder_note') {
      tr.appendChild(cell(ACTION_LABEL[c.action], null));
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'confirm-cell-summary';
      td.textContent = `${d.person_name}: ${d.note}`;
      tr.appendChild(td);
    } else {
      // update_task / update_work_item / add_stakeholder_note — show as single summary row
      tr.appendChild(cell(ACTION_LABEL[c.action] || c.action, null));
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'confirm-cell-summary';
      td.textContent = d.title || d.person_name || JSON.stringify(d);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  changesEl.appendChild(table);

  questionsEl.innerHTML = '';
  if (result.pending_questions && result.pending_questions.length > 0) {
    result.pending_questions.forEach(q => {
      const row = document.createElement('div');
      row.className = 'question-row';
      row.textContent = q;
      questionsEl.appendChild(row);
    });
    questionsWrap.style.display = '';
    document.getElementById('confirm-supplement').value = '';
  } else {
    questionsWrap.style.display = 'none';
  }

  panel.classList.add('visible');
}

async function confirmWrite() {
  if (!pendingResult) return;

  // Read edited values back from table
  const changes = [];
  pendingResult.changes.forEach((c, idx) => {
    const tr = document.querySelector(`#confirm-changes tr[data-idx="${idx}"]`);
    if (!tr) { changes.push({ ...c, confirmed: true }); return; }
    const updated = { ...c.data };
    tr.querySelectorAll('[data-field]').forEach(inp => {
      const f = inp.dataset.field;
      const v = inp.value.trim();
      if (f === 'stakeholder_names') {
        updated[f] = v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
      } else if (f === 'importance' || f === 'urgency') {
        updated[f] = v ? parseInt(v) : undefined;
      } else {
        updated[f] = v || undefined;
      }
    });
    changes.push({ ...c, data: updated, confirmed: true });
  });

  await fetch('/api/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_id: pendingResult.input_id, changes }),
  });
  cancelConfirm();
  await loadData();
  renderSchedulePlan();
}

function cancelConfirm() {
  pendingResult = null;
  document.getElementById('confirm-panel').classList.remove('visible');
  document.getElementById('confirm-changes').innerHTML = '';
  document.getElementById('confirm-questions').innerHTML = '';
  document.getElementById('confirm-questions-wrap').style.display = 'none';
  document.getElementById('confirm-supplement').value = '';
}

async function reparseSupplement() {
  if (!pendingResult) return;
  const supplement = document.getElementById('confirm-supplement').value.trim();
  if (!supplement) return;

  const btn = document.getElementById('btn-reparse');
  btn.disabled = true;
  btn.textContent = '解析中…';

  try {
    const resp = await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: supplement }),
    });
    const data = await resp.json();
    if (data.error) { alert('解析出错: ' + data.error); return; }
    // Merge: keep existing changes, add new ones from supplement, update input_id to latest
    pendingResult = {
      input_id: data.input_id,
      changes: [...pendingResult.changes, ...data.changes],
      pending_questions: data.pending_questions,
    };
    showConfirmPanel(pendingResult);
  } finally {
    btn.disabled = false;
    btn.textContent = '重新解析';
  }
}

// ── Onboarding submission ───────────────────────────────────────────────────

// Holds parsed result across parse → supplement → confirm steps
let onboardingResult = null;  // { input_id, changes }

async function submitOnboarding() {
  const text = document.getElementById('onboarding-text').value.trim();
  if (!text) return;

  const btn = document.getElementById('btn-onboard');
  const status = document.getElementById('onboard-status');
  btn.disabled = true;
  status.innerHTML = '<span class="spinner"></span> AI 解析中...';

  try {
    const inputData = await callParseApi(text, true);
    if (!inputData) { btn.disabled = false; return; }

    onboardingResult = { input_id: inputData.input_id, changes: inputData.changes };
    renderOnboardingPreview(onboardingResult.changes);

    document.getElementById('onboard-step1').style.display = 'none';
    document.getElementById('onboard-preview').style.display = 'block';
    status.textContent = '';
  } catch (e) {
    status.textContent = '出错: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function submitOnboardingSupplement() {
  const text = document.getElementById('onboard-supplement').value.trim();
  if (!text || !onboardingResult) return;

  const btn = document.getElementById('btn-onboard-supplement');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const inputData = await callParseApi(text, true);
    if (!inputData) return;

    // Merge new changes into existing, deduplicate by title
    const existingTitles = new Set(onboardingResult.changes.map(c => c.data.title));
    const newChanges = inputData.changes.filter(c => !existingTitles.has(c.data.title));
    onboardingResult.changes = [...onboardingResult.changes, ...newChanges];
    onboardingResult.input_id = inputData.input_id;

    renderOnboardingPreview(onboardingResult.changes);
    document.getElementById('onboard-supplement').value = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '补充解析';
  }
}

async function confirmOnboarding() {
  if (!onboardingResult) return;

  const btn = document.getElementById('btn-onboard-confirm');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    // Read back edited values from preview DOM
    const changes = readOnboardingPreviewChanges();

    const confirmResp = await fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_id: onboardingResult.input_id, changes }),
    });
    const confirmData = await confirmResp.json();
    if (confirmData.error) {
      alert('写入出错: ' + confirmData.error);
      return;
    }

    document.getElementById('onboarding').classList.remove('visible');
    await enterMainLayout();
  } finally {
    btn.disabled = false;
    btn.textContent = '确认写入';
  }
}

// Shared parse helper — returns inputData or null on error (sets status text)
async function callParseApi(text, isOnboarding) {
  const status = document.getElementById('onboard-status');
  const resp = await fetch('/api/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, is_onboarding: isOnboarding }),
  });
  const data = await resp.json();
  if (data.error) {
    status.textContent = '解析出错: ' + data.error;
    return null;
  }
  return data;
}

// Render the editable preview from a changes array
function renderOnboardingPreview(changes) {
  const container = document.getElementById('onboard-preview-content');
  container.innerHTML = '';

  const workItems = changes.filter(c => c.action === 'add_work_item');
  const tasks = changes.filter(c => c.action === 'add_task');

  workItems.forEach((c, i) => {
    // work item row
    container.appendChild(makeOnboardWiRow(c, i));

    // tasks belonging to this work item, indented below
    const children = tasks.filter(t =>
      t.data.work_item_title === c.data.title
    );
    children.forEach((t, j) => {
      container.appendChild(makeOnboardTaskRow(t, j));
    });
  });

  // orphan tasks (no matching work_item)
  const wiTitles = new Set(workItems.map(c => c.data.title));
  const orphans = tasks.filter(t => !wiTitles.has(t.data.work_item_title));
  if (orphans.length) {
    const label = document.createElement('div');
    label.className = 'preview-section-title';
    label.textContent = '未归属任务';
    container.appendChild(label);
    orphans.forEach((t, j) => container.appendChild(makeOnboardTaskRow(t, j)));
  }
}

function makeOnboardWiRow(change, idx) {
  const d = change.data;
  const row = document.createElement('div');
  row.className = 'preview-item';
  row.dataset.idx = idx;
  row.dataset.action = 'add_work_item';
  row.innerHTML = `
    <div>
      <div class="preview-item-title">${esc(d.title)}</div>
      <div class="preview-item-sub">${esc(d.type)}</div>
    </div>
    <div class="preview-field"><label>重要</label><input type="number" class="field-importance" min="1" max="5" value="${d.importance ?? 3}"></div>
    <div class="preview-field"><label>紧急</label><input type="number" class="field-urgency" min="1" max="5" value="${d.urgency ?? 3}"></div>
    <div class="preview-field"><label>截止</label><input type="text" class="field-deadline" placeholder="YYYY-MM-DD" value="${esc(d.deadline ?? '')}"></div>
    <button class="preview-delete" onclick="deletePreviewItem(this)" title="删除">✕</button>
  `;
  return row;
}

function makeOnboardTaskRow(change, idx) {
  const d = change.data;
  const row = document.createElement('div');
  row.className = 'preview-item is-task';
  row.dataset.idx = idx;
  row.dataset.action = 'add_task';
  row.innerHTML = `
    <div>
      <div class="preview-item-title">${esc(d.title)}</div>
      <div class="preview-item-sub">→ ${esc(d.work_item_title ?? d.work_item_id ?? '—')}</div>
    </div>
    <div class="preview-field"><label>执行人</label><input type="text" class="field-executor" placeholder="留空=本人" value="${esc(d.executor_name ?? '')}"></div>
    <div class="preview-field"><label>截止</label><input type="text" class="field-due" placeholder="YYYY-MM-DD" value="${esc(d.due_date ?? '')}"></div>
    <button class="preview-delete" onclick="deletePreviewItem(this)" title="删除">✕</button>
  `;
  return row;
}

function deletePreviewItem(btn) {
  btn.closest('.preview-item').remove();
}

// Read edited values back from DOM into changes array
function readOnboardingPreviewChanges() {
  const rows = document.querySelectorAll('#onboard-preview-content .preview-item');
  const changes = [];

  rows.forEach(row => {
    const action = row.dataset.action;
    if (action === 'add_work_item') {
      // Find matching original change to preserve other fields
      const orig = onboardingResult.changes.find(
        c => c.action === 'add_work_item' &&
        c.data.title === row.querySelector('.preview-item-title').textContent
      );
      const data = orig ? { ...orig.data } : {};
      data.importance = parseInt(row.querySelector('.field-importance').value) || 3;
      data.urgency = parseInt(row.querySelector('.field-urgency').value) || 3;
      const dl = row.querySelector('.field-deadline').value.trim();
      data.deadline = dl || null;
      changes.push({ action: 'add_work_item', data, confirmed: true });
    } else if (action === 'add_task') {
      const orig = onboardingResult.changes.find(
        c => c.action === 'add_task' &&
        c.data.title === row.querySelector('.preview-item-title').textContent
      );
      const data = orig ? { ...orig.data } : {};
      const executor = row.querySelector('.field-executor').value.trim();
      data.executor_name = executor || null;
      const due = row.querySelector('.field-due').value.trim();
      data.due_date = due || null;
      changes.push({ action: 'add_task', data, confirmed: true });
    }
  });

  return changes;
}

boot();
