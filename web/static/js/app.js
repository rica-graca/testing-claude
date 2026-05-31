/* ── Timewaste Dashboard ── */
const API = '/api';

// ── State ──────────────────────────────────────────────────────────────────
let categories = [];
let currentView = 'dashboard';

// ── Utils ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmtSec = s => {
  if (!s) return '0m';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const today = () => new Date().toISOString().slice(0, 10);

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  return res.json();
}

// ── Clock ──────────────────────────────────────────────────────────────────
function startClock() {
  const el = $('live-clock');
  const tick = () => {
    const now = new Date();
    el.textContent = now.toTimeString().slice(0, 8);
  };
  tick();
  setInterval(tick, 1000);
}

// ── Navigation ─────────────────────────────────────────────────────────────
function navigate(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $(`view-${view}`).classList.add('active');
  document.querySelector(`[data-view="${view}"]`).classList.add('active');

  if (view === 'dashboard') loadDashboard();
  else if (view === 'tasks') loadAllTasks();
  else if (view === 'report') initReport();
  else if (view === 'categories') loadCategories();
}

document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', e => { e.preventDefault(); navigate(el.dataset.view); });
});

// ── Dashboard ──────────────────────────────────────────────────────────────
async function loadDashboard() {
  const [report, tasks] = await Promise.all([
    api(`/report?from=${today()}&to=${today()}`),
    api('/tasks'),
  ]);

  $('stat-total').textContent = fmtSec(report.total_sec);
  $('stat-waste').textContent = fmtSec(report.waste_sec);
  $('stat-pct').textContent = report.waste_pct.toFixed(1) + '%';
  $('waste-bar').style.width = Math.min(report.waste_pct, 100) + '%';

  const running = (tasks || []).filter(t => t.started_at && !t.ended_at);
  $('stat-active').textContent = running.length > 0 ? running[0].title : 'None';

  renderTaskList($('running-tasks'), running, true);
  const recent = (tasks || []).filter(t => t.ended_at).slice(0, 8);
  renderTaskList($('recent-tasks'), recent, false);
}

// ── Task list renderer ─────────────────────────────────────────────────────
function renderTaskList(container, tasks, isRunning) {
  if (!tasks || tasks.length === 0) {
    container.innerHTML = `<p class="empty-state">No tasks here yet.</p>`;
    return;
  }
  container.innerHTML = tasks.map(t => taskCard(t)).join('');
  attachTaskActions(container);
}

function taskCard(t) {
  const running = t.started_at && !t.ended_at;
  const catBadge = t.category
    ? `<span class="category-badge" style="background:${t.category.color}22;color:${t.category.color}">
         <span class="category-dot" style="background:${t.category.color}"></span>${t.category.name}
       </span>` : '';
  const wasteBadge = t.is_waste ? `<span class="waste-badge">waste</span>` : '';
  const dur = t.duration_sec ? `<span>${fmtSec(t.duration_sec)}</span>` : (running ? '<span class="running-label">● running</span>' : '');

  return `
  <div class="task-card ${running ? 'running' : ''} ${t.is_waste ? 'waste-task' : ''}" data-id="${t.id}">
    <div class="task-dot ${running ? 'running' : t.is_waste ? 'waste' : ''}"></div>
    <div class="task-info">
      <div class="task-title">${escHtml(t.title)}</div>
      <div class="task-meta">${catBadge}${wasteBadge}${dur}</div>
    </div>
    <div class="task-actions">
      ${!t.started_at ? `<button class="btn-icon start" data-action="start" data-id="${t.id}" title="Start">▶</button>` : ''}
      ${running ? `<button class="btn-icon stop" data-action="stop" data-id="${t.id}" title="Stop">■</button>` : ''}
      <button class="btn-icon" data-action="edit" data-id="${t.id}" title="Edit">✎</button>
      <button class="btn-icon danger" data-action="delete" data-id="${t.id}" title="Delete">✕</button>
    </div>
  </div>`;
}

function attachTaskActions(container) {
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async e => {
      const { action, id } = btn.dataset;
      if (action === 'start') { await api(`/tasks/${id}/start`, { method: 'POST' }); refresh(); }
      if (action === 'stop')  { await api(`/tasks/${id}/stop`,  { method: 'POST' }); refresh(); }
      if (action === 'delete') {
        if (confirm('Delete this task?')) {
          await api(`/tasks/${id}`, { method: 'DELETE' });
          refresh();
        }
      }
      if (action === 'edit') openEditModal(id);
    });
  });
}

function refresh() {
  if (currentView === 'dashboard') loadDashboard();
  else if (currentView === 'tasks') loadAllTasks();
}

// ── All tasks view ─────────────────────────────────────────────────────────
async function loadAllTasks() {
  await loadCategoriesIfNeeded();
  const cat = $('filter-category').value;
  const waste = $('filter-waste').value;
  let url = '/tasks';
  const params = [];
  if (cat) params.push(`category_id=${cat}`);
  if (waste !== '') params.push(`is_waste=${waste}`);
  if (params.length) url += '?' + params.join('&');

  const tasks = await api(url);
  renderTaskList($('all-tasks'), tasks || [], false);
}

async function loadCategoriesIfNeeded() {
  if (categories.length === 0) categories = await api('/categories') || [];
  const sel = $('filter-category');
  if (sel.options.length <= 1) {
    categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id; opt.textContent = c.name;
      sel.appendChild(opt);
    });
  }
}

$('filter-category').addEventListener('change', loadAllTasks);
$('filter-waste').addEventListener('change', loadAllTasks);

// ── Report view ────────────────────────────────────────────────────────────
function initReport() {
  const from = $('report-from'), to = $('report-to');
  if (!from.value) {
    const d = new Date(); d.setDate(d.getDate() - 6);
    from.value = d.toISOString().slice(0, 10);
  }
  if (!to.value) to.value = today();
  loadReport();
}

async function loadReport() {
  const from = $('report-from').value, to = $('report-to').value;
  const report = await api(`/report?from=${from}&to=${to}`);
  const el = $('report-content');

  el.innerHTML = `
    <div class="report-summary">
      <div class="stat-card"><div class="stat-label">Total tracked</div><div class="stat-value">${fmtSec(report.total_sec)}</div></div>
      <div class="stat-card waste"><div class="stat-label">Total wasted</div><div class="stat-value">${fmtSec(report.waste_sec)}</div></div>
      <div class="stat-card"><div class="stat-label">Waste %</div><div class="stat-value">${report.waste_pct.toFixed(1)}%</div></div>
    </div>
    <div class="waste-bar-wrap" style="margin-bottom:28px"><div class="waste-bar" style="width:${Math.min(report.waste_pct,100)}%"></div></div>
    <h2 class="section-title">By category</h2>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${(report.by_category || []).map(c => `
        <div class="report-row">
          <div class="category-color-dot" style="background:${c.color};width:12px;height:12px;border-radius:50%"></div>
          <div class="report-row-info">
            <div class="report-row-name">${escHtml(c.category_name)}</div>
            <div class="report-row-meta">${c.task_count} tasks · ${fmtSec(c.total_sec)} total · ${fmtSec(c.waste_sec)} wasted</div>
          </div>
          <div class="report-bar-wrap">
            <div class="report-bar" style="width:${c.total_sec > 0 ? (c.waste_sec/c.total_sec*100).toFixed(0) : 0}%;background:${c.color}"></div>
          </div>
        </div>`).join('')}
    </div>`;
}

$('load-report-btn').addEventListener('click', loadReport);

// ── Categories view ────────────────────────────────────────────────────────
async function loadCategories() {
  categories = await api('/categories') || [];
  const el = $('categories-list');
  el.innerHTML = categories.map(c => `
    <div class="category-row">
      <div class="category-color-dot" style="background:${c.color}"></div>
      <div class="category-name">${escHtml(c.name)}</div>
      <button class="btn-icon danger" data-cat-delete="${c.id}">✕</button>
    </div>`).join('');

  el.querySelectorAll('[data-cat-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Delete category?')) {
        await api(`/categories/${btn.dataset.catDelete}`, { method: 'DELETE' });
        loadCategories();
      }
    });
  });
}

$('new-category-btn').addEventListener('click', () => {
  showModal('New Category', `
    <div class="form-group">
      <label class="form-label">Name</label>
      <input class="form-input" id="cat-name" placeholder="e.g. Slack" />
    </div>
    <div class="form-group">
      <label class="form-label">Color</label>
      <input type="color" class="form-input" id="cat-color" value="#6366f1" style="height:40px;padding:4px" />
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-submit">Create</button>
    </div>`);

  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-submit').addEventListener('click', async () => {
    const name = $('cat-name').value.trim();
    const color = $('cat-color').value;
    if (!name) return;
    await api('/categories', { method: 'POST', body: JSON.stringify({ name, color }) });
    closeModal();
    loadCategories();
  });
});

// ── New task modal ─────────────────────────────────────────────────────────
$('new-task-btn').addEventListener('click', openNewTaskModal);

async function openNewTaskModal() {
  await loadCategoriesIfNeeded();
  showModal('New Task', taskForm(null));
  attachTaskFormSubmit(null);
}

async function openEditModal(id) {
  await loadCategoriesIfNeeded();
  const task = await api(`/tasks/${id}`);
  showModal('Edit Task', taskForm(task));
  attachTaskFormSubmit(id);
}

function taskForm(task) {
  const catOptions = categories.map(c =>
    `<option value="${c.id}" ${task?.category_id === c.id ? 'selected' : ''}>${escHtml(c.name)}</option>`
  ).join('');

  return `
    <div class="form-group">
      <label class="form-label">Title *</label>
      <input class="form-input" id="tf-title" placeholder="What are you doing?" value="${task ? escHtml(task.title) : ''}" />
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <select class="form-select" id="tf-category">
        <option value="">— none —</option>
        ${catOptions}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <textarea class="form-textarea" id="tf-notes" placeholder="Optional notes...">${task?.notes || ''}</textarea>
    </div>
    <div class="form-group">
      <div class="form-checkbox-row">
        <input type="checkbox" id="tf-waste" ${task?.is_waste ? 'checked' : ''} />
        <label for="tf-waste" style="cursor:pointer">Mark as wasted time</label>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-submit">${task ? 'Save' : 'Create'}</button>
    </div>`;
}

function attachTaskFormSubmit(id) {
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-submit').addEventListener('click', async () => {
    const title = $('tf-title').value.trim();
    if (!title) return;
    const body = {
      title,
      category_id: $('tf-category').value || null,
      notes: $('tf-notes').value || null,
      is_waste: $('tf-waste').checked,
    };
    if (id) {
      await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await api('/tasks', { method: 'POST', body: JSON.stringify(body) });
    }
    closeModal();
    refresh();
  });
}

// ── Modal helpers ──────────────────────────────────────────────────────────
function showModal(title, bodyHtml) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() { $('modal-overlay').classList.add('hidden'); }
$('modal-close').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', e => { if (e.target === $('modal-overlay')) closeModal(); });

// ── Helpers ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Boot ───────────────────────────────────────────────────────────────────
startClock();
navigate('dashboard');
// Auto-refresh every 30s on dashboard
setInterval(() => { if (currentView === 'dashboard') loadDashboard(); }, 30_000);
