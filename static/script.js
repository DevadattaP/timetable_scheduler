// ─── STORAGE & STATE ────────────────────────────────────────
const KEY = {
  semesters:       'program_semesters',
  // timetable keys still at top-level (used by timetable tab)
  timetable:       'program_timetable',
  timetableMeta:   'program_timetableMeta',
  configEdit:      'program_configLastEdit',
};
const get = k => { try{ return JSON.parse(localStorage.getItem(k)) }catch{ return null } };
const set = (k,v) => localStorage.setItem(k, JSON.stringify(v));
const remove = k => localStorage.removeItem(k);

function utcNowIso() { return new Date().toISOString(); }
function normalizeTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
function timestampMs(value) {
  const normalized = normalizeTimestamp(value);
  return normalized ? Date.parse(normalized) : NaN;
}
function isConfigNewerThanTimetable(configEdit, timetableTimestamp) {
  const ct = timestampMs(configEdit), tt = timestampMs(timetableTimestamp);
  return Number.isFinite(ct) && Number.isFinite(tt) && ct > tt;
}
function touchConfig() {
  set(KEY.configEdit, utcNowIso());
  updateStaleWarning();
}
function updateStaleWarning() {
  const warn = document.getElementById('tt-stale-warn');
  if (!warn) return;
  const configEdit = get(KEY.configEdit);
  const meta = State.timetableMeta;
  warn.style.display = (meta && isConfigNewerThanTimetable(configEdit, meta.timestamp)) ? 'flex' : 'none';
}

let State = {
  semesters: [],
  // timetable (still top-level for the timetable tab)
  timetable: null,
  timetableMeta: null,
};

function loadState() {
  State.semesters    = get(KEY.semesters)      || [];
  State.timetable    = get(KEY.timetable)       || null;
  State.timetableMeta= get(KEY.timetableMeta)   || null;
}

function saveSemesters() {
  set(KEY.semesters, State.semesters);
  touchConfig();
}

// ─── HELPERS ────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function generateSemId() {
  return 'sem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
}
function getSem(id) { return State.semesters.find(s => s.id === id) || null; }

// ─── SEMESTER CARD MANAGEMENT ───────────────────────────────
let expandedSemId = null; // which card is currently open
let currentSemId  = null; // which sem the open modal belongs to

/* ── Create a new blank semester ── */
function createSemester() {
  const count = State.semesters.length + 1;
  const sem = {
    id: generateSemId(),
    name: `Semester ${count}`,
    sections: [], courses: [], faculty: [],
    sectionMappings: [], areaMappings: [],
    areas: [], courseConflicts: [],
    configMode: 'sections',
    startDate: '', endDate: '',
    constraintConfig: defaultConstraintConfig(),
  };
  State.semesters.push(sem);
  saveSemesters();
  renderSemCards();
  // auto-expand the newly added card
  toggleSemCard(sem.id);
  toast(`"${sem.name}" added.`, 'success');
}

/* ── Delete a semester card ── */
function deleteSemCard(semId) {
  const sem = getSem(semId);
  if (!sem) return;
  confirm2('Delete Semester',
    `Delete "${sem.name}" and all its data? This cannot be undone.`,
    () => {
      if (expandedSemId === semId) expandedSemId = null;
      const idx = State.semesters.findIndex(s => s.id === semId);
      if (idx !== -1) State.semesters.splice(idx, 1);
      saveSemesters();
      renderSemCards();
      toast(`"${sem.name}" deleted.`, 'warning');
    });
}

/* ── Toggle expand / collapse ── */
function toggleSemCard(semId) {
  if (expandedSemId === semId) {
    collapseSemCard(semId);
    expandedSemId = null;
  } else {
    if (expandedSemId) collapseSemCard(expandedSemId);
    expandedSemId = semId;
    expandSemCard(semId);
  }
}

function expandSemCard(semId) {
  const card = document.getElementById(`sem-card-${semId}`);
  if (!card) return;
  card.classList.add('expanded');

  // Lazily generate body content on first expand
  const body = document.getElementById(`${semId}-body`);
  if (body) {
    if (!body.children.length) body.innerHTML = semCardBodyHTML(getSem(semId));
    body.style.display = 'block';
  }

  const arrow = card.querySelector('.sem-toggle-arrow');
  if (arrow) arrow.textContent = '▲';
  const actions = card.querySelector('.sem-header-actions');
  if (actions) actions.style.display = 'flex';
  // Ensure name field is readonly while expanded (edit-mode is separate)
  const nameInput = document.getElementById(`${semId}-name-input`);
  if (nameInput) nameInput.setAttribute('readonly', true);

  // Populate dynamic lists
  renderSections(semId);
  renderAreas(semId);
  renderCourses(semId);
  renderFaculty(semId);
  renderMappings(semId);
  renderConflicts(semId);
  updateConfigModeUI(semId);
}

function collapseSemCard(semId) {
  const card = document.getElementById(`sem-card-${semId}`);
  if (!card) return;
  card.classList.remove('expanded');
  const body = document.getElementById(`${semId}-body`);
  if (body) body.style.display = 'none';
  const arrow = card.querySelector('.sem-toggle-arrow');
  if (arrow) arrow.textContent = '▼';
  const actions = card.querySelector('.sem-header-actions');
  if (actions) actions.style.display = 'none';
}

/* ── Name inline edit ── */
function startEditSemName(semId) {
  const nameInput = document.getElementById(`${semId}-name-input`);
  const editBtn   = document.getElementById(`${semId}-edit-btn`);
  const saveBtn   = document.getElementById(`${semId}-save-btn`);
  if (!nameInput) return;
  nameInput.removeAttribute('readonly');
  nameInput.focus();
  nameInput.select();
  if (editBtn) editBtn.style.display = 'none';
  if (saveBtn) saveBtn.style.display = 'inline-flex';
}

function saveSemName(semId) {
  const sem = getSem(semId);
  if (!sem) return;
  const nameInput = document.getElementById(`${semId}-name-input`);
  const editBtn   = document.getElementById(`${semId}-edit-btn`);
  const saveBtn   = document.getElementById(`${semId}-save-btn`);
  const newName = (nameInput ? nameInput.value.trim() : '') || `Semester ${State.semesters.indexOf(sem)+1}`;
  sem.name = newName;
  if (nameInput) { nameInput.value = newName; nameInput.setAttribute('readonly', true); }
  if (editBtn) editBtn.style.display = 'inline-flex';
  if (saveBtn) saveBtn.style.display = 'none';
  saveSemesters();
  toast(`Renamed to "${newName}".`, 'success');
}

/* ── Switch subtab within a card ── */
function switchSemSubtab(semId, subtab, btn) {
  const card = document.getElementById(`sem-card-${semId}`);
  if (!card) return;
  card.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  card.querySelectorAll('.sem-subtab-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById(`${semId}-subtab-${subtab}`);
  if (target) target.classList.add('active');
}

/* ── Render the full cards container ── */
function renderSemCards() {
  const container  = document.getElementById('sem-cards-container');
  const emptyState = document.getElementById('sem-empty-state');
  if (!container) return;
  if (!State.semesters.length) {
    if (emptyState) emptyState.style.display = 'block';
    container.innerHTML = '';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';
  container.innerHTML = State.semesters.map(sem => semCardHTML(sem)).join('');
  // Restore any expanded card
  if (expandedSemId && getSem(expandedSemId)) expandSemCard(expandedSemId);
}

/* ── Generate card shell HTML ── */
function semCardHTML(sem) {
  const id    = sem.id;
  const isExp = expandedSemId === id;
  return `
<div class="sem-card${isExp?' expanded':''}" id="sem-card-${id}">
  <div class="sem-card-header">
    <input id="${id}-name-input" class="sem-name-input" type="text"
      value="${escapeHtml(sem.name)}" readonly />
    <div class="sem-header-actions" style="${isExp?'display:flex':'display:none'}">
      <button id="${id}-edit-btn" class="sem-icon-btn" title="Edit name"
        onclick="startEditSemName('${id}')">✎</button>
      <button id="${id}-save-btn" class="sem-icon-btn sem-save-active" title="Save name"
        style="display:none" onclick="saveSemName('${id}')">✓</button>
      <button class="sem-icon-btn sem-delete-btn" title="Delete semester"
        onclick="deleteSemCard('${id}')">🗑</button>
    </div>
    <button class="sem-toggle-btn" onclick="toggleSemCard('${id}')"
      title="${isExp?'Collapse':'Expand'}">
      <span class="sem-toggle-arrow">${isExp?'▲':'▼'}</span>
    </button>
  </div>
  <div id="${id}-body" class="sem-card-body" style="${isExp?'':'display:none'}">
    ${isExp ? semCardBodyHTML(sem) : ''}
  </div>
</div>`;
}

/* ── Generate the full card body (subtabs + content) ── */
function semCardBodyHTML(sem) {
  const id  = sem.id;
  const cfg = sem.constraintConfig || defaultConstraintConfig();
  const isArea = sem.configMode === 'areas';
  return `
<nav class="sub-nav" style="margin-top:1rem">
  <button class="subtab-btn active" onclick="switchSemSubtab('${id}','sections',this)">Sections</button>
  <button class="subtab-btn" onclick="switchSemSubtab('${id}','courses',this)">Courses</button>
  <button class="subtab-btn" onclick="switchSemSubtab('${id}','faculty',this)">Faculty</button>
  <button class="subtab-btn" onclick="switchSemSubtab('${id}','mapping',this)">Mapping</button>
  <button class="subtab-btn" onclick="switchSemSubtab('${id}','constraints',this)">Constraints</button>
</nav>

<!-- ── SECTIONS ── -->
<div id="${id}-subtab-sections" class="sem-subtab-content active">
  <div class="card" style="margin-bottom:1.25rem;margin-top:1rem">
    <div class="card-title">📅 Teaching Period</div>
    <div class="date-range-card">
      <div class="form-group">
        <label>Start Date</label>
        <input type="date" id="${id}-start-date" value="${sem.startDate||''}"/>
      </div>
      <div class="form-group">
        <label>End Date</label>
        <input type="date" id="${id}-end-date" value="${sem.endDate||''}"/>
      </div>
      <button class="btn btn-ghost" onclick="saveDates('${id}')">Save Dates</button>
    </div>
    <div class="mode-switch-card">
      <div class="slots-label" style="margin-bottom:.35rem">Configure By</div>
      <div class="mode-switch">
        <label><input type="radio" name="config-mode-${id}" id="${id}-mode-sections" value="sections"
          ${!isArea?'checked':''} onchange="setConfigMode('${id}','sections')"/> Sections</label>
        <label><input type="radio" name="config-mode-${id}" id="${id}-mode-areas"    value="areas"
          ${isArea?'checked':''}  onchange="setConfigMode('${id}','areas')"/> Areas</label>
      </div>
    </div>
  </div>

  <div id="${id}-sections-config-wrap" ${isArea?'style="display:none"':''}>
    <div class="section-header">
      <div><h2>Sections</h2><p>Define teaching periods and available time slots per section</p></div>
      <button class="btn btn-primary" onclick="openSectionModal('add',null,'${id}')">+ Add Section</button>
    </div>
    <div id="${id}-sections-list"></div>
  </div>

  <div id="${id}-areas-config-wrap" class="card"
    style="margin-bottom:1.25rem;margin-top:1.25rem;${isArea?'':'display:none'}">
    <div class="section-header" style="margin-bottom:.75rem">
      <div><h2>Areas</h2><p>Define area-specific availability and excluded dates</p></div>
      <button class="btn btn-primary" onclick="openAreaModal('add',null,'${id}')">+ Add Area</button>
    </div>
    <div id="${id}-areas-list"></div>
  </div>
</div>

<!-- ── COURSES ── -->
<div id="${id}-subtab-courses" class="sem-subtab-content">
  <div class="section-header" style="margin-top:1rem">
    <div><h2>Courses</h2><p>Define courses and their session requirements</p></div>
    <button class="btn btn-primary" onclick="openCourseModal('add',null,'${id}')">+ Add Course</button>
  </div>
  <div id="${id}-courses-list"></div>
  <div class="card" style="margin-top:1.25rem">
    <div class="card-title" id="${id}-conflict-title">⛔ Course Conflict Groups (Tracks)</div>
    <p id="${id}-conflict-desc"
      style="font-size:.82rem;color:var(--text2);margin-bottom:.85rem;line-height:1.6">
      Courses in the same group will never be scheduled at the same time slot, even across different sections.
    </p>
    <div id="${id}-conflicts-list"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:.5rem"
      onclick="openConflictModal(null,'${id}')">+ Add Conflict Group</button>
  </div>
</div>

<!-- ── FACULTY ── -->
<div id="${id}-subtab-faculty" class="sem-subtab-content">
  <div class="section-header" style="margin-top:1rem">
    <div><h2>Faculty</h2><p>Add faculty members and mark unavailable timeslots</p></div>
    <button class="btn btn-primary" onclick="openFacultyModal('add',null,'${id}')">+ Add Faculty</button>
  </div>
  <div id="${id}-faculty-list"></div>
</div>

<!-- ── MAPPING ── -->
<div id="${id}-subtab-mapping" class="sem-subtab-content">
  <div class="section-header" style="margin-top:1rem">
    <div>
      <h2 id="${id}-mapping-title">Section-Course-Faculty Mapping</h2>
      <p  id="${id}-mapping-desc">Assign faculty to teach specific courses for specific sections</p>
    </div>
    <button class="btn btn-primary" onclick="openMappingModal('add',null,'${id}')">+ Add Mapping</button>
  </div>
  <div id="${id}-mapping-list"></div>
</div>

<!-- ── CONSTRAINTS ── -->
<div id="${id}-subtab-constraints" class="sem-subtab-content">
  ${constraintsPanelHTML(id, cfg)}
</div>`;
}

/* ── Constraints subtab HTML (scoped to card id) ── */
function constraintsPanelHTML(id, cfg) {
  const con = cfg.consecutiveRule || {enabled:true, maxConsecutive:2, periodUnit:'weeks', resetBoundary:'month'};
  const spr = cfg.spreadingRule   || {enabled:true, weight:0.1};
  return `
<div class="section-header" style="margin-top:1rem">
  <div><h2>Constraints</h2><p>Control which rules apply during schedule generation</p></div>
</div>
<div class="card" style="margin-bottom:1rem">
  <div class="card-title">🔒 Fixed Constraints <span class="badge badge-grey section-badge">Always Applied</span></div>
  <ul class="rule-list">
    <li><strong>H1 – Exact Fulfillment:</strong> Every section completes exactly the required number of sessions per course.</li>
    <li><strong>H2 – One Course per Slot:</strong> Every available slot is filled by exactly one course.</li>
    <li><strong>H3 – No Faculty Cloning:</strong> A faculty member cannot teach two sections simultaneously.</li>
    <li><strong>H4 – Max Daily Workload:</strong> Faculty cannot exceed their configured maximum sessions per calendar day.</li>
    <li><strong>H5 – Daily Course Spacing:</strong> A section cannot have the same course more than once in a single day.</li>
  </ul>
</div>
<div class="card">
  <div class="card-title">⚙ Optional Constraints</div>

  <div class="constraint-item">
    <label class="constraint-toggle">
      <input type="checkbox" id="${id}-c-unavail" ${cfg.facultyUnavailability?'checked':''}/>
      <div>
        <strong>H6 – Faculty Unavailability</strong>
        <p>Block scheduling faculty on their marked unavailable timeslots.</p>
      </div>
    </label>
  </div>

  <hr class="form-divider"/>

  <div class="constraint-item">
    <label class="constraint-toggle">
      <input type="checkbox" id="${id}-c-conflicts" ${cfg.courseConflicts?'checked':''}/>
      <div>
        <strong>H7 – Course Conflict Groups (Tracks)</strong>
        <p>Prevent courses in the same conflict group from running at the same time slot.</p>
      </div>
    </label>
  </div>

  <hr class="form-divider"/>

  <div class="constraint-item">
    <label class="constraint-toggle">
      <input type="checkbox" id="${id}-c-consec-enabled" ${con.enabled?'checked':''}
        onchange="toggleConsecDetail('${id}',this.checked)"/>
      <div>
        <strong>Consecutive Sessions Rule</strong>
        <span class="badge badge-gold section-badge" style="margin-left:.4rem">Soft — Penalty</span>
        <p>Limit how many consecutive periods the same course can be taught to a section.</p>
      </div>
    </label>
    <div class="constraint-detail" id="${id}-c-consec-detail"
      style="${con.enabled?'':'display:none'}">
      <div class="form-row" style="margin-top:.85rem;align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="min-width:0;flex:0 0 auto">
          <label>Max Consecutive</label>
          <div style="display:flex;gap:.4rem;align-items:center">
            <input type="number" id="${id}-c-consec-max" min="1" max="10"
              value="${con.maxConsecutive||2}" style="width:56px;text-align:center"/>
            <select id="${id}-c-consec-unit" style="width:100px">
              <option value="weeks" ${(con.periodUnit||'weeks')==='weeks'?'selected':''}>Week(s)</option>
              <option value="days"  ${con.periodUnit==='days'?'selected':''}>Day(s)</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="min-width:0;flex:0 0 auto">
          <label>Reset Boundary</label>
          <select id="${id}-c-consec-boundary" style="width:160px">
            <option value="none"  ${(con.resetBoundary||'month')==='none'?'selected':''}>None (continuous)</option>
            <option value="month" ${(con.resetBoundary||'month')==='month'?'selected':''}>Month</option>
          </select>
        </div>
      </div>
      <p style="font-size:.77rem;color:var(--muted);margin-top:.3rem;line-height:1.5">
        A penalty fires when the same course appears in <strong>(max+1)</strong> consecutive periods.
        Solver minimises total penalty.
      </p>
    </div>
  </div>

  <hr class="form-divider"/>

  <div class="constraint-item">
    <label class="constraint-toggle">
      <input type="checkbox" id="${id}-c-spread-enabled" ${spr.enabled?'checked':''}
        onchange="toggleSpreadDetail('${id}',this.checked)"/>
      <div>
        <strong>Session Spreading Rule</strong>
        <span class="badge badge-gold section-badge" style="margin-left:.4rem">Soft — Penalty</span>
        <p>Encourage sessions to be distributed evenly across the scheduling period rather than clustering.</p>
      </div>
    </label>
    <div class="constraint-detail" id="${id}-c-spread-detail"
      style="${spr.enabled?'':'display:none'}">
      <div class="form-row" style="margin-top:.85rem;align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="min-width:0;flex:0 0 auto">
          <label>Penalty Weight</label>
          <input type="number" id="${id}-c-spread-weight" min="0.01" max="1" step="0.01"
            value="${spr.weight||0.1}" style="width:72px;text-align:center"/>
        </div>
      </div>
      <p style="font-size:.77rem;color:var(--muted);margin-top:.3rem;line-height:1.5">
        Period divided into equal epochs — one per required session.
        Empty epochs are penalised. Recommended weight range: 0.01–0.5.
      </p>
    </div>
  </div>

  <div style="margin-top:1rem;display:flex;justify-content:flex-end">
    <button class="btn btn-primary" onclick="saveConstraintConfig('${id}')">Save Constraints</button>
  </div>
</div>`;
}

// TOAST
function toast(msg, type='info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const icons = {
    success:'✓',
    error:'✕',
    warning:'⚠',
    info:'ⓘ',
  };
  const duration = {
    success: 2000,
    error: 5000,
    warning: 3000,
    info: 2000,
  }

  el.innerHTML = `
    <span>${icons[type] || 'ⓘ'}</span>
    <span>${msg}</span>
  `;

  c.appendChild(el);

  let startTime = Date.now();
  let remaining = duration[type];
  let timeoutId;

  function dismiss() {
    el.style.animation = 'fadeOut .25s ease forwards';
    setTimeout(() => el.remove(), 250);
  }

  function startTimer() {
    startTime = Date.now();
    timeoutId = setTimeout(dismiss, remaining);
  }

  function pauseTimer() {
    clearTimeout(timeoutId);
    remaining -= Date.now() - startTime;
  }

  el.addEventListener('mouseenter', pauseTimer);
  el.addEventListener('mouseleave', startTimer);

  startTimer();
}

// ─── TABS ────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById(`tab-${btn.dataset.tab}`);
    if (target) target.classList.add('active');
    // Configure tab: nothing extra needed — cards handle their own sub-tabs
  });
});
// NOTE: per-card subtab switching is handled by switchSemSubtab() with inline onclick

// MODAL
let _modalSaveFn = null;
let _confirmFn = null;
function openModal(title, bodyHTML, saveFn) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  _modalSaveFn = saveFn;
  clearModalError();
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  _modalSaveFn = null;
  clearModalError();
}
function clearModalError() {
  const el = document.getElementById('modal-err');
  if (el) el.classList.remove('show');
}
function showModalError(msg) {
  const el = document.getElementById('modal-err');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

// CONFIRM
function confirm2(title, msg, fn) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-msg').textContent = msg;
  _confirmFn = fn;
  document.getElementById('confirm-overlay').classList.add('open');
}
function closeConfirm() {
  document.getElementById('confirm-overlay').classList.remove('open');
  _confirmFn = null;
}
document.getElementById('confirm-ok').addEventListener('click', () => { if (_confirmFn) _confirmFn(); closeConfirm(); });
document.getElementById('confirm-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeConfirm(); });

// ─── DATES ────────────────────────────────────────────────────
function saveDates(semId) {
  const sem = getSem(semId);
  if (!sem) return;
  const s = document.getElementById(`${semId}-start-date`).value;
  const e = document.getElementById(`${semId}-end-date`).value;
  if (!s||!e) { toast('Please set both start and end date.','warning'); return; }
  if (s>=e)   { toast('End date must be after start date.','error');   return; }
  sem.startDate = s;
  sem.endDate   = e;
  saveSemesters();
  toast('Teaching period saved.','success');
}

// ─── SECTIONS CRUD ────────────────────────────────────────────
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function sectionSlotRowHTML(slot, idx, rowPrefix='section') {
  return `<div class="slot-row" id="${rowPrefix}-slot-row-${idx}">
    <div class="form-group">
      <label>Weekday</label>
      <select class="slot-weekday">${WEEKDAYS.map(w=>`<option${slot&&slot.weekday===w?' selected':''}>${w}</option>`).join('')}</select>
    </div>
    <div class="form-group" style="max-width:100px">
      <label>From</label>
      <input type="time" class="slot-from" value="${slot?slot.fromTime:'09:00'}"/>
    </div>
    <div class="form-group" style="max-width:100px">
      <label>To</label>
      <input type="time" class="slot-to" value="${slot?slot.toTime:'11:45'}"/>
    </div>
    <div class="form-group" style="max-width:80px">
      <label>Duration</label>
      <input type="number" class="slot-dur" min="0.5" step="0.5" value="${slot?slot.duration:2.5}" style="text-align:center"/>
    </div>
    <button class="btn btn-danger btn-icon btn-sm" style="margin-bottom:0;flex-shrink:0"
      onclick="removeSlotRow('${rowPrefix}',${idx})">✕</button>
  </div>`;
}

let _slotCounter = 0;
function addSlotRow(slot, containerId='slots-container', rowPrefix='section') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const idx = _slotCounter++;
  const div = document.createElement('div');
  div.innerHTML = sectionSlotRowHTML(slot, idx, rowPrefix);
  container.appendChild(div.firstElementChild);
}
function removeSlotRow(rowPrefix, idx) {
  const el = document.getElementById(`${rowPrefix}-slot-row-${idx}`);
  if (el) el.remove();
}

function sectionModalBody(sec) {
  _slotCounter = 0;
  return `
    <div class="modal-error" id="modal-err"></div>
    <div class="form-row">
      <div class="form-group">
        <label>Section Name</label>
        <input type="text" id="sec-name" placeholder="e.g. A" value="${sec?sec.name:''}"/>
      </div>
    </div>
    <hr class="form-divider"/>
    <div class="slots-label">Available Slots</div>
    <div id="slots-container"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:.4rem" onclick="addSlotRow(null)">+ Add Slot</button>`;
}

function readSlots(containerId='slots-container') {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return Array.from(container.querySelectorAll('.slot-row')).map(row => ({
    weekday:  (row.querySelector('.slot-weekday')||{}).value || 'Saturday',
    fromTime: (row.querySelector('.slot-from')||{}).value   || '09:00',
    toTime:   (row.querySelector('.slot-to')||{}).value     || '11:45',
    duration: parseFloat((row.querySelector('.slot-dur')||{}).value) || 2.5,
  }));
}

function openSectionModal(mode, idx, semId) {
  currentSemId = semId;
  const sem  = getSem(semId);
  const sec  = (mode!=='add') ? sem.sections[idx] : null;
  const title = mode==='edit' ? 'Edit Section' : mode==='dup' ? 'Duplicate Section' : 'Add Section';
  openModal(title, sectionModalBody(sec), () => saveSectionModal(mode, idx));
  const slots = sec ? sec.slots : [{weekday:'Saturday',fromTime:'09:00',toTime:'11:45',duration:2.5}];
  slots.forEach(s => addSlotRow(s));
}

function saveSectionModal(mode, editIdx) {
  clearModalError();
  const sem  = getSem(currentSemId);
  const name = document.getElementById('sec-name').value.trim();
  if (!name) { showModalError('Section name is required.'); return; }
  const slots = readSlots('slots-container');
  if (!slots.length) { showModalError('At least one slot is required.'); return; }
  const obj = {name, slots};
  const dup = sem.sections.find((s,i) => s.name===name && (mode==='add'||mode==='dup'||i!==editIdx));
  if (dup) { showModalError(`Section "${name}" already exists.`); return; }
  if (mode==='edit') {
    const oldName = sem.sections[editIdx].name;
    if (oldName !== name) {
      sem.sectionMappings.forEach(m => { if (m.section===oldName) m.section=name; });
      sem.courseConflicts.forEach(group => {
        const i = group.sections.indexOf(oldName);
        if (i !== -1) group.sections[i] = name;
      });
    }
    sem.sections[editIdx] = obj;
  } else {
    sem.sections.push(obj);
  }
  saveSemesters();
  renderSections(currentSemId);
  renderMappings(currentSemId);
  renderConflicts(currentSemId);
  closeModal();
  toast(`Section "${name}" saved.`, 'success');
}

function deleteSection(idx, semId) {
  currentSemId = semId;
  const sem = getSem(semId);
  const s   = sem.sections[idx];
  confirm2('Delete Section',
    `Delete section "${s.name}"? Mappings using this section will also be removed.`,
    () => {
      sem.sectionMappings = sem.sectionMappings.filter(m => m.section!==s.name);
      const toDelete = [];
      let modified = 0;
      sem.courseConflicts.forEach((group, gi) => {
        const si = group.sections.indexOf(s.name);
        if (si !== -1) {
          group.sections.splice(si, 1);
          if (group.sections.length < 2) toDelete.push(gi); else modified++;
        }
      });
      toDelete.reverse().forEach(di => sem.courseConflicts.splice(di, 1));
      sem.sections.splice(idx, 1);
      saveSemesters();
      renderSections(semId); renderMappings(semId); renderConflicts(semId);
      toast(`Section "${s.name}" deleted.`, 'warning');
      if (toDelete.length) toast(`${toDelete.length} conflict group(s) removed.`, 'info');
      if (modified)        toast(`${modified} conflict group(s) updated.`, 'info');
    });
}

function renderSections(semId) {
  const sem = getSem(semId);
  const el  = document.getElementById(`${semId}-sections-list`);
  if (!el || !sem) return;
  if (!sem.sections.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗓</div><p>No sections added yet.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Name</th><th>Slots</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>${sem.sections.map((s,i)=>`<tr>
      <td><span class="badge badge-gold">${s.name}</span></td>
      <td style="font-size:.8rem;color:var(--text2)">${s.slots.map(sl=>
        `<span class="badge badge-grey" style="margin:.1rem">${sl.weekday.slice(0,3)} ${sl.fromTime}</span>`
      ).join(' ')}</td>
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit"
          onclick="openSectionModal('edit',${i},'${semId}')">✎</button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Duplicate"
          onclick="openSectionModal('dup',${i},'${semId}')">⎘</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete"
          onclick="deleteSection(${i},'${semId}')">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function setConfigMode(semId, mode) {
  const sem = getSem(semId);
  if (!sem) return;
  sem.configMode = mode;
  saveSemesters();
  updateConfigModeUI(semId);
  renderSections(semId); renderAreas(semId); renderCourses(semId);
  renderMappings(semId); renderConflicts(semId);
}

function updateConfigModeUI(semId) {
  const sem = getSem(semId);
  if (!sem) return;
  const areaMode = sem.configMode === 'areas';
  const g = id => document.getElementById(`${semId}-${id}`);

  const sw = g('sections-config-wrap'), aw = g('areas-config-wrap');
  if (sw) sw.style.display = areaMode ? 'none' : 'block';
  if (aw) aw.style.display = areaMode ? 'block' : 'none';

  const mTitle = g('mapping-title'), mDesc = g('mapping-desc');
  const cTitle = g('conflict-title'), cDesc = g('conflict-desc');
  if (mTitle) mTitle.textContent = areaMode ? 'Course-Faculty Mapping' : 'Section-Course-Faculty Mapping';
  if (mDesc)  mDesc.textContent  = areaMode
    ? 'Assign faculty to teach specific courses.'
    : 'Assign faculty to teach specific courses for specific sections.';
  if (cTitle) cTitle.textContent = areaMode ? '⛔ Course Conflict Groups' : '⛔ Course Conflict Groups (Tracks)';
  if (cDesc)  cDesc.textContent  = areaMode
    ? 'Courses in the same group will never be scheduled at the same time slot.'
    : 'Courses in the same group will never be scheduled at the same time slot, even across different sections.';
}

// ─── AREAS CRUD ───────────────────────────────────────────────
function areaSlotRowHTML(slot, idx) { return sectionSlotRowHTML(slot, idx, 'area'); }

let _areaDateCounter = 0;
function areaExcludedDateRowHTML(val, idx) {
  const sem = getSem(currentSemId);
  const minDate = sem ? sem.startDate : '';
  const maxDate = sem ? sem.endDate   : '';
  return `<div id="area-date-row-${idx}" style="display:flex;gap:.5rem;margin-bottom:.4rem;align-items:center">
    <input type="date" class="area-excluded-date" value="${val||''}"
      ${minDate?`min="${minDate}"`:''}${maxDate?` max="${maxDate}"`:''}
      style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);
        padding:.45rem .65rem;border-radius:var(--r);font-family:var(--font-u);font-size:.85rem"/>
    <button class="btn btn-danger btn-icon btn-sm" onclick="removeAreaDateRow(${idx})">✕</button>
  </div>`;
}

function addAreaDateRow(val='') {
  const c = document.getElementById('area-excluded-container');
  if (!c) return;
  const idx = _areaDateCounter++;
  const div = document.createElement('div');
  div.innerHTML = areaExcludedDateRowHTML(val, idx);
  c.appendChild(div.firstElementChild);
}

function removeAreaDateRow(idx) {
  const el = document.getElementById(`area-date-row-${idx}`);
  if (el) el.remove();
}

function readExcludedDates(containerId='area-excluded-container') {
  const c = document.getElementById(containerId);
  if (!c) return [];
  return Array.from(c.querySelectorAll('.area-excluded-date')).map(i=>i.value).filter(Boolean);
}

function areaModalBody(area) {
  _slotCounter = 0; _areaDateCounter = 0;
  const sem = getSem(currentSemId);
  const minDate = sem ? sem.startDate : '';
  const maxDate = sem ? sem.endDate   : '';
  return `
    <div class="modal-error" id="modal-err"></div>
    <div class="form-row">
      <div class="form-group">
        <label>Area Name</label>
        <input type="text" id="area-name" placeholder="e.g. Science Block" value="${area?area.name:''}"/>
      </div>
      <div class="form-group">
        <label>Short Name</label>
        <input type="text" id="area-short" placeholder="e.g. SCI" value="${area?area.shortName:''}"/>
      </div>
    </div>
    <hr class="form-divider"/>
    <div class="slots-label">Weekday Slot Pairs</div>
    <div id="area-slots-container"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:.4rem"
      onclick="addSlotRow(null,'area-slots-container','area')">+ Add Slot</button>
    <hr class="form-divider"/>
    <div class="slots-label">Excluded Dates</div>
    <p style="font-size:.77rem;color:var(--muted);margin:.15rem 0 .6rem;line-height:1.5">
      Select dates within the teaching period to exclude from this area.
      ${minDate&&maxDate ? `Allowed range: ${minDate} to ${maxDate}.` : 'Set the teaching period to constrain excluded dates.'}
    </p>
    <div id="area-excluded-container"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:.4rem" onclick="addAreaDateRow('')">+ Add Date</button>`;
}

function openAreaModal(mode, idx, semId) {
  currentSemId = semId;
  const sem  = getSem(semId);
  const area = (mode !== 'add') ? sem.areas[idx] : null;
  openModal(mode==='edit'?'Edit Area':'Add Area', areaModalBody(area), () => saveAreaModal(mode, idx));
  const slots = area ? area.slots : [{weekday:'Saturday',fromTime:'09:00',toTime:'11:45',duration:2.5}];
  (area ? area.excludedDates||[] : []).forEach(d => addAreaDateRow(d));
  slots.forEach(s => addSlotRow(s, 'area-slots-container', 'area'));
}

function saveAreaModal(mode, editIdx) {
  clearModalError();
  const sem       = getSem(currentSemId);
  const name      = document.getElementById('area-name').value.trim();
  const shortName = document.getElementById('area-short').value.trim();
  if (!name||!shortName) { showModalError('Area name and short name are required.'); return; }
  const slots = readSlots('area-slots-container');
  if (!slots.length) { showModalError('At least one weekday-slot pair is required.'); return; }
  const excludedDates = readExcludedDates('area-excluded-container');
  if (excludedDates.length && (!sem.startDate||!sem.endDate)) {
    showModalError('Set the teaching period before adding excluded dates.'); return;
  }
  if (excludedDates.length && sem.startDate && sem.endDate) {
    const bad = excludedDates.find(d => d<sem.startDate||d>sem.endDate);
    if (bad) { showModalError(`Excluded date ${bad} is outside the teaching period.`); return; }
  }
  const dup = sem.areas.find((a,i) => a.shortName===shortName && (mode==='add'||i!==editIdx));
  if (dup) { showModalError(`Area short name "${shortName}" already exists.`); return; }
  const obj = {name, shortName, slots, excludedDates};
  if (mode==='edit') {
    const oldArea = sem.areas[editIdx];
    if (oldArea && oldArea.shortName!==shortName)
      sem.courses.forEach(c => { if (c.areaShortName===oldArea.shortName) c.areaShortName=shortName; });
    sem.areas[editIdx] = obj;
  } else { sem.areas.push(obj); }
  saveSemesters();
  renderAreas(currentSemId); renderCourses(currentSemId);
  closeModal(); toast(`Area "${shortName}" saved.`, 'success');
}

function deleteArea(idx, semId) {
  currentSemId = semId;
  const sem  = getSem(semId);
  const area = sem.areas[idx];
  const linked = sem.courses.filter(c => c.areaShortName===area.shortName);
  confirm2('Delete Area',
    `Delete area "${area.shortName}"?${linked.length?' '+linked.length+' course(s) will be cleared.':''}`,
    () => {
      let cleared = 0;
      sem.courses.forEach(c => { if (c.areaShortName===area.shortName) { c.areaShortName=''; cleared++; } });
      sem.areas.splice(idx, 1);
      saveSemesters();
      renderAreas(semId); renderCourses(semId);
      toast(`Area "${area.shortName}" deleted.`, 'warning');
      if (cleared) toast(`${cleared} course(s) cleared.`, 'info');
    });
}

function renderAreas(semId) {
  const sem = getSem(semId);
  const el  = document.getElementById(`${semId}-areas-list`);
  if (!el || !sem) return;
  if (!sem.areas.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🧭</div><p>No areas added yet.</p></div>`;
    return;
  }
  const cnt = Object.fromEntries(sem.areas.map(a=>[a.shortName,0]));
  sem.courses.forEach(c => { if (c.areaShortName && cnt[c.areaShortName]!==undefined) cnt[c.areaShortName]++; });
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Name</th><th>Short</th><th>Slot Pairs</th><th>Excluded Dates</th><th>Courses</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>${sem.areas.map((area,i)=>`<tr>
      <td>${area.name}</td>
      <td><span class="badge badge-gold" style="font-family:var(--font-m)">${area.shortName}</span></td>
      <td style="font-size:.8rem;color:var(--text2)">${(area.slots||[]).map(sl=>
        `<span class="badge badge-grey" style="margin:.1rem">${sl.weekday.slice(0,3)} ${sl.fromTime}</span>`
      ).join(' ')}</td>
      <td style="font-size:.8rem;color:var(--text2)">${(area.excludedDates||[]).length
        ? (area.excludedDates||[]).map(d=>`<span class="badge badge-grey" style="margin:.1rem">${d}</span>`).join(' ')
        : '<span style="color:var(--muted)">None</span>'}</td>
      <td><span class="badge badge-blue">${cnt[area.shortName]||0}</span></td>
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit"
          onclick="openAreaModal('edit',${i},'${semId}')">✎</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete"
          onclick="deleteArea(${i},'${semId}')">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ─── COURSES CRUD ─────────────────────────────────────────────
function courseModalBody(c) {
  const sem      = getSem(currentSemId);
  const areaMode = sem ? sem.configMode==='areas' : false;
  const areas    = sem ? sem.areas : [];
  const areaOpts = areaMode
    ? (areas.length
        ? `<option value="">-- Select Area --</option>` + areas.map(a=>
            `<option value="${a.shortName}"${c&&c.areaShortName===a.shortName?' selected':''}>${a.shortName} - ${a.name}</option>`
          ).join('')
        : `<option value="">-- No Areas Defined --</option>`)
    : '';
  return `
    <div class="modal-error" id="modal-err"></div>
    <div class="form-row">
      <div class="form-group"><label>Course Code</label>
        <input type="text" id="c-code" placeholder="e.g. P-201" value="${c?c.code:''}"/></div>
      <div class="form-group"><label>Short Title</label>
        <input type="text" id="c-short" placeholder="e.g. OR" value="${c?c.shortTitle:''}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group" style="flex:2"><label>Course Title</label>
        <input type="text" id="c-title" placeholder="e.g. Operations Research" value="${c?c.title:''}"/></div>
    </div>
    ${areaMode ? `
    <div class="form-row">
      <div class="form-group" style="flex:2"><label>Area</label>
        <select id="c-area">${areaOpts}</select></div>
      <div class="form-group"><label>Max Sessions / Month</label>
        <input type="number" id="c-max-month" min="0" step="1"
          value="${c&&c.maxSessionsPerMonth!=null?c.maxSessionsPerMonth:4}"/></div>
    </div>` : ''}
    <div class="form-row">
      <div class="form-group"><label>Credit</label>
        <input type="number" id="c-credit" min="0" step="0.5" value="${c?c.credit:2}"/></div>
      <div class="form-group"><label>Duration (hrs)</label>
        <input type="number" id="c-duration" min="0" step="0.5" value="${c?c.duration:20}"/></div>
      <div class="form-group"><label>Required Slots</label>
        <input type="number" id="c-slots" min="1" value="${c?c.requiredSlots:8}"/></div>
    </div>`;
}

function openCourseModal(mode, idx, semId) {
  currentSemId = semId;
  const sem = getSem(semId);
  const c   = (mode!=='add') ? sem.courses[idx] : null;
  const title = mode==='edit'?'Edit Course':mode==='dup'?'Duplicate Course':'Add Course';
  openModal(title, courseModalBody(c), () => saveCourseModal(mode, idx));
}

function saveCourseModal(mode, editIdx) {
  clearModalError();
  const sem    = getSem(currentSemId);
  const code   = document.getElementById('c-code').value.trim();
  const title  = document.getElementById('c-title').value.trim();
  const short  = document.getElementById('c-short').value.trim();
  const credit = parseFloat(document.getElementById('c-credit').value)||0;
  const dur    = parseFloat(document.getElementById('c-duration').value)||0;
  const slots  = parseInt(document.getElementById('c-slots').value)||0;
  if (!code||!title) { showModalError('Course code and title are required.'); return; }
  const areaMode = sem.configMode==='areas';
  const obj = {
    ...(mode==='edit'?(sem.courses[editIdx]||{}):{} ),
    code, title, shortTitle:short, credit, duration:dur, requiredSlots:slots,
  };
  if (areaMode) {
    obj.areaShortName       = document.getElementById('c-area').value;
    obj.maxSessionsPerMonth = parseInt(document.getElementById('c-max-month').value)||0;
  } else if (mode==='add') { delete obj.areaShortName; delete obj.maxSessionsPerMonth; }
  const dup = sem.courses.find((c,i)=>c.code===code&&(mode==='add'||mode==='dup'||i!==editIdx));
  if (dup) { showModalError(`Course code "${code}" already exists.`); return; }
  if (mode==='edit') sem.courses[editIdx]=obj; else sem.courses.push(obj);
  saveSemesters(); renderCourses(currentSemId);
  closeModal(); toast(`Course "${code}" saved.`, 'success');
}

function deleteCourse(idx, semId) {
  currentSemId = semId;
  const sem = getSem(semId);
  const c   = sem.courses[idx];
  confirm2('Delete Course', `Delete "${c.code}"? Mappings using this course will also be removed.`, () => {
    sem.sectionMappings = sem.sectionMappings.filter(m=>m.courseCode!==c.code);
    sem.areaMappings    = sem.areaMappings.filter(m=>m.courseCode!==c.code);
    sem.courses.splice(idx, 1);
    saveSemesters(); renderCourses(semId); renderMappings(semId);
    toast(`Course "${c.code}" deleted.`, 'warning');
  });
}

function renderCourses(semId) {
  const sem = getSem(semId);
  const el  = document.getElementById(`${semId}-courses-list`);
  if (!el || !sem) return;
  if (!sem.courses.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📚</div><p>No courses added yet.</p></div>`;
    return;
  }
  const areaMode = sem.configMode==='areas';
  const areaMap  = Object.fromEntries(sem.areas.map(a=>[a.shortName,a]));
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Code</th><th>Title</th><th>Short</th>${areaMode?'<th>Area</th>':''}
      <th>Credit</th><th>Req Slots</th>${areaMode?'<th>Max Monthly</th>':''}
      <th style="width:120px">Actions</th></tr></thead>
    <tbody>${sem.courses.map((c,i)=>`<tr>
      <td><span class="badge badge-blue" style="font-family:var(--font-m)">${c.code}</span></td>
      <td>${c.title}</td>
      <td><span class="badge badge-grey">${c.shortTitle||'—'}</span></td>
      ${areaMode?`<td><span class="badge badge-gold" style="font-family:var(--font-m)">${areaMap[c.areaShortName]?areaMap[c.areaShortName].shortName:'—'}</span></td>`:''}
      <td>${c.credit}</td>
      <td><span class="badge badge-gold">${c.requiredSlots}</span></td>
      ${areaMode?`<td><span class="badge badge-blue">${c.maxSessionsPerMonth||0}</span></td>`:''}
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit"
          onclick="openCourseModal('edit',${i},'${semId}')">✎</button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Duplicate"
          onclick="openCourseModal('dup',${i},'${semId}')">⎘</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete"
          onclick="deleteCourse(${i},'${semId}')">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ─── COURSE CONFLICTS CRUD ────────────────────────────────────
function conflictModalBody(groupIdx) {
  const sem      = getSem(currentSemId);
  if (!sem) return '';
  const areaMode  = sem.configMode==='areas';
  const group     = groupIdx===null ? null : sem.courseConflicts[groupIdx];
  const selC      = new Set(group ? group.courses       : []);
  const selS      = new Set(group ? (group.sections||[]) : []);
  return `
    <div class="modal-error" id="modal-err"></div>
    <div class="slots-label">Courses (select at least 2)</div>
    ${!sem.courses.length
      ? '<p style="color:var(--muted);font-size:.82rem">No courses defined.</p>'
      : sem.courses.map(c => `
          <label style="display:flex;align-items:center;gap:.5rem;padding:.3rem 0;font-size:.85rem;cursor:pointer">
            <input type="checkbox" class="conflict-course-chk" value="${c.code}" ${selC.has(c.code)?'checked':''}>
            <span class="badge badge-blue" style="font-family:var(--font-m)">${c.shortTitle||c.code}</span>
            <span style="color:var(--text2)">${c.title}</span>
          </label>`).join('')}
    ${!areaMode ? `
    <hr class="form-divider"/>
    <div class="slots-label">Sections (select at least 2)</div>
    ${!sem.sections.length
      ? '<p style="color:var(--muted);font-size:.82rem">No sections defined.</p>'
      : sem.sections.map(s => `
          <label style="display:flex;align-items:center;gap:.5rem;padding:.3rem 0;font-size:.85rem;cursor:pointer">
            <input type="checkbox" class="conflict-section-chk" value="${s.name}" ${selS.has(s.name)?'checked':''}>
            <span class="badge badge-gold">${s.name}</span>
          </label>`).join('')}` : ''}`;
}

function openConflictModal(groupIdx, semId) {
  currentSemId = semId;
  openModal(groupIdx===null?'Add Conflict Group':'Edit Conflict Group',
    conflictModalBody(groupIdx), () => saveConflictModal(groupIdx));
}

function saveConflictModal(groupIdx) {
  clearModalError();
  const sem      = getSem(currentSemId);
  const areaMode = sem.configMode==='areas';
  const selC = [...document.querySelectorAll('.conflict-course-chk:checked')].map(e=>e.value);
  const selS = [...document.querySelectorAll('.conflict-section-chk:checked')].map(e=>e.value);
  if (selC.length < 2)           { showModalError('Select at least 2 courses.');  return; }
  if (!areaMode && selS.length<2){ showModalError('Select at least 2 sections.'); return; }
  const existing = groupIdx===null ? {courses:[],sections:[]} : (sem.courseConflicts[groupIdx]||{courses:[],sections:[]});
  const obj = {...existing, courses:selC, sections:areaMode?[]:selS};
  if (groupIdx===null) sem.courseConflicts.push(obj); else sem.courseConflicts[groupIdx]=obj;
  saveSemesters(); renderConflicts(currentSemId); closeModal(); toast('Conflict group saved.','success');
}

function deleteConflictGroup(i, semId) {
  currentSemId = semId;
  const sem = getSem(semId);
  confirm2('Delete Conflict Group', 'Remove this conflict group?', () => {
    sem.courseConflicts.splice(i, 1);
    saveSemesters(); renderConflicts(semId); toast('Conflict group removed.','warning');
  });
}

function renderConflicts(semId) {
  const sem = getSem(semId);
  const el  = document.getElementById(`${semId}-conflicts-list`);
  if (!el || !sem) return;
  const areaMode = sem.configMode==='areas';
  const visible  = sem.courseConflicts
    .map((group, oi) => ({group, oi}))
    .filter(({group}) => areaMode ? (!group.sections||!group.sections.length)
                                  : !!(group.sections&&group.sections.length));
  if (!visible.length) {
    el.innerHTML = `<div style="font-size:.82rem;color:var(--muted);padding:.4rem 0">No conflict groups defined.</div>`;
    return;
  }
  const cMap = Object.fromEntries(sem.courses.map(c=>[c.code,c]));
  el.innerHTML = visible.map(({group, oi}, vi) => {
    const allSecs     = sem.sections.map(s=>s.name);
    const grpSecs     = group.sections||[];
    const isAllSecs   = !areaMode && grpSecs.length===allSecs.length && grpSecs.every(s=>allSecs.includes(s));
    return `
      <div class="slot-row" style="align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem">
        <span style="font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;flex-shrink:0">
          Group ${vi+1}
        </span>
        <div style="display:flex;flex-wrap:wrap;gap:.35rem;flex:1">
          ${group.courses.map(code=>{const c=cMap[code];
            return `<span class="badge badge-blue" style="font-family:var(--font-m)">${c?c.shortTitle||code:code}</span>`;
          }).join('')}
        </div>
        ${!areaMode?`
        <div style="display:flex;flex-wrap:wrap;gap:.3rem;align-items:center">
          <span style="font-size:.73rem;color:var(--muted);flex-shrink:0">Sections:</span>
          ${isAllSecs
            ? `<span class="badge badge-gold">All</span>`
            : grpSecs.map(s=>`<span class="badge badge-grey" style="font-family:var(--font-m)">${s}</span>`).join('')}
        </div>`:''}
        <div style="display:flex;gap:.3rem;flex-shrink:0;margin-left:auto">
          <button class="btn btn-ghost btn-icon btn-sm" title="Edit"
            onclick="openConflictModal(${oi},'${semId}')">✎</button>
          <button class="btn btn-danger btn-icon btn-sm" title="Delete"
            onclick="deleteConflictGroup(${oi},'${semId}')">✕</button>
        </div>
      </div>`;
  }).join('');
}

// ─── FACULTY CRUD ─────────────────────────────────────────────
let _dateCounter = 0;

// ── Slot helpers (use currentSemId – modal-only context) ──────
function getAvailableSlotOptionsForDate(facShort, dateStr) {
  const sem = getSem(currentSemId);
  if (!sem || !dateStr) return [];
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return [];
  const weekday = WEEKDAYS[d.getDay()];
  const opts = [], seen = new Set();
  const areaMode = sem.configMode==='areas';
  if (!areaMode) {
    sem.sections.forEach(sec => {
      if (sem.sectionMappings.length > 0) {
        const ok = sem.sectionMappings.some(m=>m.section===sec.name&&m.facultyShortName===facShort);
        if (!ok && facShort) return;
      }
      for (const sl of sec.slots||[]) {
        if (sl.weekday!==weekday) continue;
        if (sem.startDate&&sem.endDate&&(dateStr<sem.startDate||dateStr>sem.endDate)) continue;
        const k=`${sl.fromTime}||${sl.toTime}`;
        if (!seen.has(k)) { seen.add(k); opts.push({value:k, label:`${sl.fromTime} – ${sl.toTime}`}); }
      }
    });
  } else {
    sem.areas.forEach(area => {
      if (Array.isArray(area.excludedDates)&&area.excludedDates.includes(dateStr)) return;
      if (sem.areaMappings.length > 0) {
        const ok = sem.areaMappings.some(m=>{
          const c=sem.courses.find(c=>c.code===m.courseCode);
          return m.facultyShortName===facShort&&c&&c.areaShortName===area.shortName;
        });
        if (!ok && facShort) return;
      }
      for (const sl of area.slots||[]) {
        if (sl.weekday!==weekday) continue;
        if (sem.startDate&&sem.endDate&&(dateStr<sem.startDate||dateStr>sem.endDate)) continue;
        const k=`${sl.fromTime}||${sl.toTime}`;
        if (!seen.has(k)) { seen.add(k); opts.push({value:k, label:`${sl.fromTime} – ${sl.toTime}`}); }
      }
    });
  }
  return opts.sort((a,b)=>a.label.localeCompare(b.label));
}

function getAllowedWeekdaysForFaculty(facShort) {
  const sem  = getSem(currentSemId);
  const days = new Set();
  if (!sem || !facShort) return days;
  const areaMode = sem.configMode==='areas';
  if (!areaMode) {
    if (sem.sectionMappings.length > 0) {
      sem.sectionMappings.filter(m=>m.facultyShortName===facShort).map(m=>m.section).forEach(sname=>{
        const sec=sem.sections.find(s=>s.name===sname);
        if (sec) (sec.slots||[]).forEach(sl=>days.add(sl.weekday));
      });
    } else { sem.sections.forEach(sec=>(sec.slots||[]).forEach(sl=>days.add(sl.weekday))); }
  } else {
    if (sem.areaMappings.length > 0) {
      sem.areaMappings.filter(m=>m.facultyShortName===facShort).map(m=>m.courseCode).forEach(code=>{
        const course=sem.courses.find(c=>c.code===code); if (!course) return;
        const area=sem.areas.find(a=>a.shortName===course.areaShortName); if (!area) return;
        (area.slots||[]).forEach(sl=>days.add(sl.weekday));
      });
    } else { sem.areas.forEach(area=>(area.slots||[]).forEach(sl=>days.add(sl.weekday))); }
  }
  return days;
}

function getAllowedDatesForFaculty(facShort) {
  const sem = getSem(currentSemId);
  const allowed = [];
  if (!sem||!sem.startDate||!sem.endDate) return allowed;
  const wkdays = getAllowedWeekdaysForFaculty(facShort);
  if (!wkdays.size) return allowed;
  const areaMode = sem.configMode==='areas';
  for (let d=new Date(sem.startDate+'T00:00:00'), e=new Date(sem.endDate+'T00:00:00'); d<=e; d.setDate(d.getDate()+1)) {
    if (!wkdays.has(WEEKDAYS[d.getDay()])) continue;
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (areaMode) {
      const areasSeen = new Set();
      sem.areaMappings.filter(m=>m.facultyShortName===facShort).forEach(m=>{
        const c=sem.courses.find(c=>c.code===m.courseCode);
        if (c&&c.areaShortName) areasSeen.add(c.areaShortName);
      });
      let excluded=false;
      areasSeen.forEach(as=>{
        const area=sem.areas.find(a=>a.shortName===as);
        if (area&&Array.isArray(area.excludedDates)&&area.excludedDates.includes(ds)) excluded=true;
      });
      if (excluded) continue;
    }
    allowed.push(ds);
  }
  return allowed;
}

function getUsedSlotsFromUI(date, excludeRow=null) {
  const used = [];
  document.querySelectorAll('#unavail-container > div').forEach(div => {
    if (excludeRow && div===excludeRow) return;
    const dateEl = div.querySelector('.unavail-date');
    const slotEl = div.querySelector('.unavail-slot');
    if (!dateEl||!slotEl) return;
    if (dateEl.value===date && slotEl.value) used.push(slotEl.value);
  });
  return used;
}

function addUnavailRow(val={date:'',fromTime:'',toTime:''}) {
  const c = document.getElementById('unavail-container');
  const sem = getSem(currentSemId);
  if (!sem||!sem.startDate||!sem.endDate) { toast('Set teaching period before adding unavailable slots.','warning'); return; }
  if (sem.configMode!=='areas'&&!sem.sections.length) { toast('Add sections before marking unavailable slots.','warning'); return; }
  if (sem.configMode==='areas'&&!sem.areas.length)    { toast('Add areas before marking unavailable slots.','warning');    return; }

  const idx = _dateCounter++;
  const div = document.createElement('div');
  div.id = 'date-row-'+idx;
  div.style.cssText = 'display:flex;gap:.5rem;margin-bottom:.4rem;align-items:center;flex-wrap:wrap;';

  const dateVal=val&&val.date?val.date:'', ftVal=val&&val.fromTime?val.fromTime:'', ttVal=val&&val.toTime?val.toTime:'';
  div.dataset.slotKey = ftVal&&ttVal?`${ftVal}||${ttVal}`:'';

  const facShortEl = document.getElementById('f-short');
  const facShort   = facShortEl ? facShortEl.value.trim() : '';
  const allowedDates = getAllowedDatesForFaculty(facShort).filter(date=>{
    const opts = getAvailableSlotOptionsForDate(facShort, date).map(o=>o.value);
    const used = getUsedSlotsFromUI(date);
    return opts.length > used.length;
  });
  const dateOptions = allowedDates.map(d=>{
    const dt=new Date(d+'T00:00:00');
    return `<option value="${d}">${d} (${WEEKDAYS[dt.getDay()]})</option>`;
  }).join('');
  div.innerHTML = `
    <select class="unavail-date" style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:.45rem .65rem;border-radius:var(--r);font-family:var(--font-u);font-size:.85rem">
      <option value="">(select date)</option>${dateOptions}
    </select>
    <select class="unavail-slot" style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:.45rem .65rem;border-radius:var(--r);font-family:var(--font-u);font-size:.85rem;min-width:150px">
      <option value="">(select slot)</option>
    </select>
    <button class="btn btn-danger btn-icon btn-sm" onclick="document.getElementById('date-row-${idx}').remove()">✕</button>`;
  c.appendChild(div);

  const dateInput = div.querySelector('.unavail-date');
  const slotSelect= div.querySelector('.unavail-slot');

  function refreshOpts(dv, row) {
    const fs2  = (document.getElementById('f-short')||{}).value||'';
    const opts = getAvailableSlotOptionsForDate(fs2, dv);

    const used = new Set(getUsedSlotsFromUI(dv, row));
    const filtered = opts.filter(o=>!used.has(o.value));
    const cur = slotSelect.value || row.dataset.slotKey;
    slotSelect.innerHTML = '<option value="">(select slot)</option>'+
      filtered.map(o=>`<option value="${o.value}">${o.label}</option>`).join('');
    if (cur && filtered.some(o=>o.value===cur)) slotSelect.value=cur;
  }

  dateInput.addEventListener('change', () => {
    const dv=dateInput.value; if (!dv) return;
    const allowed=getAllowedDatesForFaculty((document.getElementById('f-short')||{}).value||'');

    if (allowed.length && !allowed.includes(dv)) {
      toast('Selected date is not valid for this faculty.','warning');
      dateInput.value=''; slotSelect.innerHTML='<option value="">(select slot)</option>'; return;
    }
    refreshOpts(dv, div);
    if (slotSelect.options.length<=1) toast('No defined slots fall on this date.','warning');
  });

  dateInput.addEventListener('input', ()=>dateInput.dispatchEvent(new Event('change')));

  slotSelect.addEventListener('change', ()=>{ 
    if (dateInput.value) refreshOpts(dateInput.value, div); 
  });

  if (dateVal) {
    const allowed3=getAllowedDatesForFaculty((document.getElementById('f-short')||{}).value||'');
    if (!allowed3.length || allowed3.includes(dateVal)) {
      dateInput.value=dateVal;
      refreshOpts(dateVal, div);
      setTimeout(()=>{ 
        const k=ftVal&&ttVal?`${ftVal}||${ttVal}`:''; 
        if(k){slotSelect.value=k;div.dataset.slotKey=k;} 
      }, 0);
    }
  }
}

function facultyModalBody(f) {
  _dateCounter = 0;
  return `
    <div class="modal-error" id="modal-err"></div>     
    <div class="form-row">
      <div class="form-group" style="flex:2">
        <label>Full Name</label>
        <input type="text" id="f-full" placeholder="e.g. Prof. Prashant N Reddy" value="${f?f.fullName:''}"/>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Short Name</label>
        <input type="text" id="f-short" placeholder="e.g. Prof PNR" value="${f?f.shortName:''}"/>
      </div>
      <div class="form-group">
        <label>Max Load / Day</label>
        <input type="number" id="f-load" min="1" max="10" value="${f?f.maxLoadPerDay:2}"/>
      </div>
    </div>
    <hr class="form-divider"/>
    <div class="slots-label">Unavailable Time Slots</div>
    <div id="unavail-container"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:.4rem" onclick="addUnavailRow({})">
      + Add Time Slot
    </button>`;
}

function openFacultyModal(mode, idx, semId) {
  currentSemId = semId;
  const sem = getSem(semId);
  const f   = (mode!=='add') ? sem.faculty[idx] : null;
  openModal(mode==='edit'?'Edit Faculty':'Add Faculty', facultyModalBody(f), ()=>saveFacultyModal(mode, idx));

  if (f) {
    const slots = f.unavailableSlots||(f.unavailableDates?f.unavailableDates.map(d=>({date:d,fromTime:'',toTime:''})):[]);
    slots.forEach(s=>addUnavailRow(s));
  }

  const fShortEl = document.getElementById('f-short');
  if (fShortEl) {
    fShortEl.addEventListener('change', () => {
      document.querySelectorAll('#unavail-container > div').forEach(div=>{
        const dateSel=div.querySelector('.unavail-date'); if (!dateSel) return;
        const prev=dateSel.value;
        const opts=getAllowedDatesForFaculty(fShortEl.value.trim());
        dateSel.innerHTML='<option value="">(select date)</option>'+ 
          opts.map(d=>{const dt=new Date(d+'T00:00:00');
            return `<option value="${d}"${d===prev?' selected':''}>${d} (${WEEKDAYS[dt.getDay()]})</option>`;
          }).join('');
      });
    });
  }
}

function saveFacultyModal(mode, editIdx) {
  clearModalError();
  const sem   = getSem(currentSemId);
  const full  = document.getElementById('f-full').value.trim();
  const short = document.getElementById('f-short').value.trim();
  const load  = parseInt(document.getElementById('f-load').value)||2;

  if (!full||!short) { showModalError('Full name and short name are required.'); return; }

  const unavailableSlots = Array.from(document.querySelectorAll('#unavail-container > div')).map(div=>{
    const dEl=div.querySelector('.unavail-date'), sEl=div.querySelector('.unavail-slot');
    if (!dEl||!sEl||!dEl.value||!sEl.value) return null;
    const [fromTime,toTime]=sEl.value.split('||');
    
    return {date:dEl.value, fromTime:fromTime||'', toTime:toTime||''};
  }).filter(Boolean);

  const obj = {fullName:full, shortName:short, maxLoadPerDay:load, unavailableSlots};
  const dup = sem.faculty.find((f,i)=>f.shortName===short&&(mode==='add'||i!==editIdx));

  if (dup) { showModalError(`Short name "${short}" already exists.`); return; }

  if (mode==='edit') sem.faculty[editIdx]=obj; else sem.faculty.push(obj);

  saveSemesters(); 
  renderFaculty(currentSemId); 
  renderMappings(currentSemId);
  closeModal(); 
  toast(`Faculty "${short}" saved.`, 'success');
}

function deleteFaculty(idx, semId) {
  currentSemId = semId;
  const sem = getSem(semId);
  const f   = sem.faculty[idx];

  confirm2('Delete Faculty', `Delete "${f.fullName}"?`, () => {
    sem.sectionMappings = sem.sectionMappings.filter(m=>m.facultyShortName!==f.shortName);
    sem.areaMappings    = sem.areaMappings.filter(m=>m.facultyShortName!==f.shortName);
    sem.faculty.splice(idx, 1);
    saveSemesters(); 
    renderFaculty(semId); 
    renderMappings(semId);
    toast(`Faculty "${f.shortName}" deleted.`, 'warning');
  });
}

function renderFaculty(semId) {
  const sem = getSem(semId);
  const el  = document.getElementById(`${semId}-faculty-list`);

  if (!el || !sem) return;

  if (!sem.faculty.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">👨‍🏫</div><p>No faculty added yet.</p></div>`;
    return;
  }

  el.innerHTML = 
  `<div class="table-wrap">
    <table class="data-table">     
      <thead><tr><th>Full Name</th><th>Short Name</th><th>Max/Day</th><th>Unavailable Slots</th><th style="width:90px">Actions</th></tr></thead>     
      <tbody>${sem.faculty.map((f,i)=>`<tr>
        <td>${f.fullName}</td>
        <td><span class="badge badge-gold" style="font-family:var(--font-m)">${f.shortName}</span></td>
        <td style="text-align:center">${f.maxLoadPerDay}</td>
        <td style="font-size:.78rem;color:var(--text2)">
          ${(Array.isArray(f.unavailableSlots)&&f.unavailableSlots.length)
            ? f.unavailableSlots.map(s=>`<span class="badge badge-grey" style="margin:.1rem">${s.date}${s.fromTime?' '+s.fromTime+'-'+s.toTime:''}</span>`).join(' ')
            : '<span style="color:var(--muted)">None</span>'}</td>
        <td>
          <button class="btn btn-ghost btn-icon btn-sm" title="Edit"
                onclick="openFacultyModal('edit',${i},'${semId}')">✎</button>
          <button class="btn btn-danger btn-icon btn-sm" title="Delete"
                onclick="deleteFaculty(${i},'${semId}')">✕</button>
        </td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}

// ─── MAPPING CRUD ─────────────────────────────────────────────
function mappingModalBody(m) {
  const sem      = getSem(currentSemId);
  if (!sem) return '';
  const areaMode = sem.configMode==='areas';
  const secOpts  = areaMode ? '' : sem.sections.map(s=>
    `<option value="${s.name}"${m&&m.section===s.name?' selected':''}>${s.name}</option>`).join('');
  const cOpts = sem.courses.map(c=>
    `<option value="${c.code}"${m&&m.courseCode===c.code?' selected':''}>${c.code} - ${c.title}</option>`).join('');
  const fOpts = sem.faculty.map(f=>
    `<option value="${f.shortName}"${m&&m.facultyShortName===f.shortName?' selected':''}>${f.shortName}</option>`).join('');
  return `
    <div class="modal-error" id="modal-err"></div>
    ${areaMode?'':`<div class="form-row"><div class="form-group"><label>Section</label>
      <select id="m-sec">${secOpts||'<option disabled>No sections</option>'}</select></div></div>`}
    <div class="form-row"><div class="form-group"><label>Course</label>
      <select id="m-course">${cOpts||'<option disabled>No courses</option>'}</select></div></div>
    <div class="form-row"><div class="form-group"><label>Faculty</label>
      <select id="m-fac">${fOpts||'<option disabled>No faculty</option>'}</select></div></div>`;
}

function openMappingModal(mode, idx, semId) {
  currentSemId = semId;
  const sem      = getSem(semId);
  const areaMode = sem.configMode==='areas';
  const maps     = areaMode ? sem.areaMappings : sem.sectionMappings;
  const m        = (mode!=='add') ? maps[idx] : null;
  if ((!areaMode&&!sem.sections.length)||!sem.courses.length||!sem.faculty.length) {
    toast(areaMode?'Add courses and faculty first.':'Add sections, courses, and faculty first.','warning'); return;
  }
  openModal(mode==='edit'?'Edit Mapping':mode==='dup'?'Duplicate Mapping':'Add Mapping',
    mappingModalBody(m), ()=>saveMappingModal(mode, idx));
}

function saveMappingModal(mode, editIdx) {
  clearModalError();
  const sem      = getSem(currentSemId);
  const areaMode = sem.configMode==='areas';
  const maps     = areaMode ? sem.areaMappings : sem.sectionMappings;
  const existing = mode==='edit' ? (maps[editIdx]||{}) : {};
  const secEl    = document.getElementById('m-sec');
  const code     = document.getElementById('m-course').value;
  const fac      = document.getElementById('m-fac').value;
  const secVal   = secEl ? secEl.value : '';
  if ((!areaMode&&!secVal)||!code||!fac) { showModalError('All fields are required.'); return; }
  const obj = {...existing, courseCode:code, facultyShortName:fac};
  if (areaMode) delete obj.section; else obj.section=secVal;
  const dup = maps.find((m,i)=> areaMode
    ? m.courseCode===code && m.facultyShortName===fac && (mode==='add'||mode==='dup'||i!==editIdx)
    : m.section===secVal  && m.courseCode===code      && (mode==='add'||mode==='dup'||i!==editIdx));
  if (dup) { showModalError(areaMode?`Mapping ${code}/${fac} exists.`:`Mapping ${secVal}/${code} exists.`); return; }
  if (mode==='edit') maps[editIdx]=obj; else maps.push(obj);
  saveSemesters(); renderMappings(currentSemId); closeModal(); toast('Mapping saved.','success');
}

function deleteMapping(idx, semId) {
  currentSemId = semId;
  const sem      = getSem(semId);
  const areaMode = sem.configMode==='areas';
  confirm2('Delete Mapping', areaMode?'Remove this course-faculty mapping?':'Remove this section-course-faculty mapping?', ()=>{
    if (areaMode) sem.areaMappings.splice(idx,1); else sem.sectionMappings.splice(idx,1);
    saveSemesters(); renderMappings(semId); toast('Mapping removed.','warning');
  });
}

function renderMappings(semId) {
  const sem      = getSem(semId);
  const el       = document.getElementById(`${semId}-mapping-list`);
  if (!el || !sem) return;
  const areaMode = sem.configMode==='areas';
  const maps     = areaMode ? sem.areaMappings : sem.sectionMappings;
  if (!maps.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔗</div><p>No mappings added yet.</p></div>`;
    return;
  }
  const cMap = Object.fromEntries(sem.courses.map(c=>[c.code,c]));
  const fMap = Object.fromEntries(sem.faculty.map(f=>[f.shortName,f]));
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr>${areaMode?'':`<th>Section</th>`}<th>Course</th><th>Faculty</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>${maps.map((m,index)=>`<tr>
      ${areaMode?'':`<td><span class="badge badge-gold">${m.section}</span></td>`}
      <td><span class="badge badge-blue" style="font-family:var(--font-m);margin-right:.35rem">${m.courseCode}</span>${cMap[m.courseCode]?cMap[m.courseCode].title:m.courseCode}</td>
      <td>${fMap[m.facultyShortName]?fMap[m.facultyShortName].fullName:m.facultyShortName}</td>
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit"
          onclick="openMappingModal('edit',${index},'${semId}')">✎</button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Duplicate"
          onclick="openMappingModal('dup',${index},'${semId}')">⎘</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete"
          onclick="deleteMapping(${index},'${semId}')">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// semId optional — when called with no arg (legacy timetable/verify code), falls back to the expanded or first semester.
function isAreaMode(semId) {
  if (semId === undefined) {
    const sem = (expandedSemId && getSem(expandedSemId)) || State.semesters[0];
    return sem ? sem.configMode === 'areas' : false;
  }
  const sem = getSem(semId);
  return sem ? sem.configMode === 'areas' : false;
}

function isSectionMode(semId) { return !isAreaMode(semId); }

// TIMETABLE GENERATION
const COURSE_PALETTE = ['#4f8ef7','#4caf7d','#c4953a','#9b6af5','#e07d3a','#e05252','#2aa3b8','#b84585'];
let _courseColorMap = {};
const TTView = {mode: 'section'}; // section | course | faculty

function getCourseColor(code) {
  if(!_courseColorMap[code]) {
    const idx = Object.keys(_courseColorMap).length % COURSE_PALETTE.length;
    _courseColorMap[code] = COURSE_PALETTE[idx];
  }
  return _courseColorMap[code];
}

// ─── CONFIG DATA & VALIDATION ────────────────────────────────
function getConfigData() {
  return {
    semesters: State.semesters.map(sem => {
      const areaMode = sem.configMode === 'areas';
      const courses = sem.courses.map(c => {
        const base = {
          code: c.code, title: c.title, shortTitle: c.shortTitle,
          credit: c.credit, duration: c.duration, requiredSlots: c.requiredSlots,
        };
        if (areaMode) {
          base.areaShortName       = c.areaShortName || '';
          base.maxSessionsPerMonth = c.maxSessionsPerMonth || 0;
        }
        return base;
      });
      return {
        id: sem.id, name: sem.name,
        configMode: sem.configMode,
        startDate:  sem.startDate,
        endDate:    sem.endDate,
        sections:   areaMode ? []          : sem.sections,
        areas:      areaMode ? sem.areas   : [],
        courses,
        faculty:    sem.faculty,
        mappings:   areaMode ? sem.areaMappings : sem.sectionMappings,
        courseConflicts: sem.courseConflicts.filter(g =>
          areaMode
            ? (!g.sections || !g.sections.length)
            : !!(g.sections && g.sections.length)
        ),
        constraintConfig: sem.constraintConfig || defaultConstraintConfig(),
      };
    }),
  };
}

function validateConfig() {
  if (!State.semesters.length)
    return ['No semesters configured. Add at least one semester in the Configure tab.'];
  const errs = [];
  State.semesters.forEach(sem => {
    const lbl = `"${sem.name}"`;
    if (!sem.startDate || !sem.endDate)
      errs.push(`${lbl}: Teaching period (start/end date) not set.`);
    if (sem.configMode === 'areas') {
      if (!sem.areas.length)    errs.push(`${lbl}: No areas defined.`);
    } else {
      if (!sem.sections.length) errs.push(`${lbl}: No sections defined.`);
    }
    if (!sem.courses.length) errs.push(`${lbl}: No courses defined.`);
    if (!sem.faculty.length) errs.push(`${lbl}: No faculty defined.`);
    const maps = sem.configMode === 'areas' ? sem.areaMappings : sem.sectionMappings;
    if (!maps.length)
      errs.push(`${lbl}: No ${sem.configMode === 'areas' ? 'course-faculty' : 'section-course-faculty'} mappings defined.`);
  });
  return errs;
}

async function generateTimetable() {
  const errs = validateConfig();
  if (errs.length) { toast(errs[0], 'error'); return; }

  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span><span>Solving… <span id="elapsed">0</span>s</span>`;
  const elapsedEl = btn.querySelector('#elapsed');
  let elapsed = 0;
  const timer = setInterval(() => { elapsed++; if (elapsedEl) elapsedEl.textContent = elapsed; }, 1000);

  try {
    const res = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getConfigData()),   // sends { semesters: [...] }
    });
    const data = await res.json();
    clearInterval(timer); btn.disabled = false; btn.innerHTML = '⚡ Generate Timetable';
    if (data.status === 'error') {
      toast('Error: ' + data.message.replace(/\n/g,'<br/>'), 'error'); return;
    }
    if (data.status === 'Infeasible') {
      toast(data.message.replace(/\n/g,'<br/>'), 'error'); return;
    }
    State.timetable = data.timetable;
    State.timetableMeta = {
      status:         data.status,
      timestamp:      normalizeTimestamp(data.timestamp) || utcNowIso(),
      constraintType: data.constraint_type,
      penalty:        data.penalty,
    };
    set(KEY.timetable,     State.timetable);
    set(KEY.timetableMeta, State.timetableMeta);
    document.getElementById('verify-results').style.display = 'none';
    refreshTimetableTab();
    toast(
      `Timetable generated! Constraint: ${data.constraint_type}` +
      (data.penalty > 0 ? ` | Penalty: ${data.penalty}` : ''),
      'success'
    );
  } catch(e) {
    clearInterval(timer); btn.disabled = false; btn.innerHTML = '⚡ Generate Timetable';
    toast('Request failed. Is the server running?', 'error');
    console.error(e);
  }
}

function switchTTView(mode, el){
  TTView.mode = mode;

  Object.values(ActiveFilters).forEach(set => set.clear());

  document.querySelectorAll('.tt-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');

  refreshTimetableTab();
}

function refreshTimetableTab() {
  const meta = State.timetableMeta;
  const tt   = State.timetable;
  const noTT = document.getElementById('tt-no-timetable');
  const metaCard = document.getElementById('tt-meta-card');
  const verifyBtn = document.getElementById('verify-btn');
  const exportViewBtn = document.getElementById('export-view-btn');

  if(!tt||!tt.length){
    noTT.style.display='block'; metaCard.style.display='none';
    document.getElementById('tt-table-wrap').style.display='none';
    verifyBtn.style.display='none';
    exportViewBtn.style.display='none';
    return;
  }
  noTT.style.display='none'; metaCard.style.display='flex';
  verifyBtn.style.display='inline-flex';
  exportViewBtn.style.display='inline-flex';

  const ts = new Date(normalizeTimestamp(meta.timestamp));
  document.getElementById('tt-meta-time').textContent = ts.toLocaleString();
  document.getElementById('tt-meta-status').textContent = meta.status;
  document.getElementById('tt-meta-type').innerHTML = meta.constraintType==='hard'
    ? '<span class="badge badge-grey">No consecutive rule</span>'
    : '<span class="badge badge-blue">Soft (penalty minimized)</span>';
  document.getElementById('tt-meta-penalty').textContent =
    meta.constraintType==='hard' ? 'N/A' : meta.penalty+' penalty score';
  document.getElementById('tt-meta-total').textContent = tt.length+' sessions';

  // stale check
  const configEdit = get(KEY.configEdit);
  const stale = isConfigNewerThanTimetable(configEdit, meta.timestamp);
  document.getElementById('tt-stale-warn').style.display = stale?'flex':'none';

  // build color map
  _courseColorMap = {};
  const allCodes = [...new Set(tt.map(r=>r.courseCode))];
  allCodes.forEach((_,i)=>{}); // pre-populate order

  document.getElementById('tt-table-wrap').style.display='block';
  resetAllFilters();
  populateFilters(tt);
  renderTimetableRows();
}

const ActiveFilters = {
  date: new Set(),
  day: new Set(),
  time: new Set(),
  section: new Set(),
};

function toggleFilter(key){
  const isAlreadyOpen = document.getElementById(`filter-${key}`).classList.contains('open');

  // Close all, reset all th z-indices
  document.querySelectorAll('.filter').forEach(f => f.classList.remove('open'));
  document.querySelectorAll('#tt-thead th').forEach(th => th.style.zIndex = '');

  if (isAlreadyOpen) return;

  const filter = document.getElementById(`filter-${key}`);
  const th = filter.closest('th');
  if (th) th.style.zIndex = '200';   // lift above sibling sticky ths

  filter.classList.add('open');

  const dropdown = filter.querySelector('.filter-dropdown');
  const rect = filter.getBoundingClientRect();
  dropdown.style.top  = (rect.bottom + 6) + 'px';
  dropdown.style.left = rect.left + 'px';
  const rightOverflow = rect.left + 200 - window.innerWidth;
  if (rightOverflow > 0) dropdown.style.left = (rect.left - rightOverflow - 10) + 'px';
}

function toggleFilterValue(key, el){
  if(el.checked) ActiveFilters[key].add(el.value);
  else ActiveFilters[key].delete(el.value);

  const total = document.querySelectorAll(`#opts-${key} input`).length;
  const allCheckbox = document.querySelector(`#filter-${key} input[type="checkbox"]`);

  if (allCheckbox) {
    allCheckbox.checked = ActiveFilters[key].size === total;
  }

  renderTimetableRows();
}

function toggleAll(key, el){
  const opts = document.querySelectorAll(`#opts-${key} input`);

  ActiveFilters[key].clear();

  if(el.checked){
    opts.forEach(o=>{
      o.checked = true;
      ActiveFilters[key].add(o.value);
    });
  }else{
    opts.forEach(o=>o.checked=false);
  }

  renderTimetableRows();
}

function filterSearch(key, val){
  val = val.toLowerCase();
  document.querySelectorAll(`#opts-${key} label`).forEach(l=>{
    l.style.display = l.textContent.toLowerCase().includes(val) ? '' : 'none';
  });
}

document.addEventListener('click', e=>{
  if(!e.target.closest('.filter')){
    document.querySelectorAll('.filter').forEach(f=>f.classList.remove('open'));
    document.querySelectorAll('#tt-thead th').forEach(th => th.style.zIndex = '');
  }
});

function resetAllFilters() {
  Object.keys(ActiveFilters).forEach(k => {
    ActiveFilters[k].clear();
  });
}

function filterThHTML(key, label, stickyClass = '') {
  return `<th rowspan="2" class="${stickyClass}">
    <div class="filter" id="filter-${key}">
      <div class="filter-btn" onclick="toggleFilter('${key}')">${label} ⌄</div>
      <div class="filter-dropdown">
        <input type="text" placeholder="Search..." oninput="filterSearch('${key}', this.value)">
        <label><input type="checkbox" onchange="toggleAll('${key}', this)"> All</label>
        <div class="filter-options" id="opts-${key}"></div>
      </div>
    </div>
  </th>`;
}

function getTTColumns(tt){
  if(TTView.mode === 'section'){
    return [...new Set(tt.map(r => r.section))].sort();
  }

  if(TTView.mode === 'course'){
    return [...new Set(tt.map(r => r.courseCode))].sort();
  }

  if(TTView.mode === 'faculty'){
    return [...new Set(tt.map(r => r.faculty))].sort();
  }

  return [];
}

function getCellKey(row){
  if(TTView.mode === 'section') return row.section;
  if(TTView.mode === 'course') return row.courseCode;
  if(TTView.mode === 'faculty') return row.faculty;
}

function populateFilters(tt) {
  const allCols = getTTColumns(tt);

  // Init filters on first call
  const rowFields = {
    date: [...new Set(tt.map(r => r.date))].sort(),
    day:  [...new Set(tt.map(r => r.day))],
    time: [...new Set(tt.map(r => r.timeLabel))].sort(),
  };
  Object.entries(rowFields).forEach(([key, vals]) => {
    if (ActiveFilters[key].size === 0) vals.forEach(v => ActiveFilters[key].add(v));
  });
  if (ActiveFilters.section.size === 0) {
    if (TTView.mode === 'section') {
      allCols.forEach(s => ActiveFilters.section.add(s));
    } else {
      // course / faculty → only first column selected
      if (allCols.length) {
        ActiveFilters.section.add(allCols[0]);
      }
    }
  }

  // Build 2-row thead
  const visibleSections = allCols.filter(s => ActiveFilters.section.has(s));
  const sectionOptsHTML = allCols.map(s => `
    <label>
      <input type="checkbox" value="${s}" ${ActiveFilters.section.has(s) ? 'checked' : ''}
        onchange="toggleFilterValue('section', this)">
      ${s}
    </label>`).join('');
  const labelMap = {
    section: TTView.mode === 'section' ? isAreaMode() ? 'Areas' : 'Sections' : TTView.mode === 'course' ? 'Courses' : 'Faculty'
  };
  document.getElementById('tt-thead').innerHTML = `
    <tr>
      ${filterThHTML('date', 'Date', 'tt-sticky-0')}
      ${filterThHTML('day',  'Day',  'tt-sticky-1')}
      ${filterThHTML('time', 'Time', 'tt-sticky-2')}
      <th colspan="${visibleSections.length}" style="text-align:center;padding:.5rem">
        <div class="filter" id="filter-section">
          <div class="filter-btn" onclick="toggleFilter('section')">${labelMap.section} ⌄</div>
          <div class="filter-dropdown">
            <input type="text" placeholder="Search..." oninput="filterSearch('section', this.value)">
            <label><input type="checkbox" ${ActiveFilters.section.size === allCols.length ? 'checked' : ''} onchange="toggleAll('section', this)"> All</label>
            <div class="filter-options" id="opts-section">${sectionOptsHTML}</div>
          </div>
        </div>
      </th>
    </tr>
    <tr>
      ${visibleSections.map(s =>
        `<th style="text-align:center;font-weight:600;font-size:.82rem;padding:.45rem .6rem">${s}</th>`
      ).join('')}
    </tr>`;

  freezeTheadRow2();

  // Populate date/day/time dropdown options
  Object.entries(rowFields).forEach(([key, vals]) => {
    const box = document.getElementById(`opts-${key}`);
    const allCheckbox = document.querySelector(`#filter-${key} input[type="checkbox"]`);
    if (!box) return;
    box.innerHTML = vals.map(v => `
      <label>
        <input type="checkbox" value="${v}" ${ActiveFilters[key].has(v) ? 'checked' : ''}
          onchange="toggleFilterValue('${key}', this)">
        ${v}
      </label>`).join('');
    if (allCheckbox) allCheckbox.checked = ActiveFilters[key].size === vals.length;
  });
}

function freezeTheadRow2() {
  requestAnimationFrame(() => {
    const row1 = document.querySelector('#tt-thead tr:first-child');
    const row2Ths = document.querySelectorAll('#tt-thead tr:last-child th');
    if (row1 && row2Ths.length) {
      const h = row1.getBoundingClientRect().height;
      row2Ths.forEach(th => {
        th.style.position = 'sticky';
        th.style.top = h + 'px';
        th.style.background = 'var(--bg)';
        th.style.zIndex = '5';
      });
    }
  });
}

function renderTimetableRows() {
  const tt = State.timetable;
  if (!tt || !tt.length) return;

  // 1. Filter by date/day/time filters
  const filtered = tt.filter(r =>
    (!ActiveFilters.date.size || ActiveFilters.date.has(r.date)) &&
    (!ActiveFilters.day.size  || ActiveFilters.day.has(r.day)) &&
    (!ActiveFilters.time.size || ActiveFilters.time.has(r.timeLabel))
  );

  // 2. Visible sections (respects section filter)
  const allCols = getTTColumns(tt);
  const sections = allCols.filter(s => !ActiveFilters.section.size || ActiveFilters.section.has(s));

  // Sync second thead row and Sections colspan
  const thead = document.getElementById('tt-thead');
  const theadRows = thead.querySelectorAll('tr');
  if (theadRows.length >= 2) {
    theadRows[1].innerHTML = sections.map(s =>
      `<th style="text-align:center;font-weight:600;font-size:.82rem;padding:.45rem .6rem">${s}</th>`
    ).join('');
  }
  freezeTheadRow2();
  const secTh = thead.querySelector('tr:first-child th[colspan]');
  if (secTh) secTh.colSpan = Math.max(1, sections.length);

  const tbody = document.getElementById('tt-tbody');
  const numCols = 3 + sections.length;

  if (!filtered.length || !sections.length) {
    tbody.innerHTML = `<tr><td colspan="${numCols}" class="empty-state">No sessions match the current filters.</td></tr>`;
    return;
  }

  // 3. Sort by date then time
  filtered.sort((a, b) => a.date.localeCompare(b.date) || a.timeLabel.localeCompare(b.timeLabel));

  // 4. Group: outer = date+day, inner = timeLabel
  const dateGroups = new Map();
  filtered.forEach(r => {
    const dk = `${r.date}||${r.day}`;
    if (!dateGroups.has(dk)) dateGroups.set(dk, { date: r.date, day: r.day, times: new Map() });
    const tm = dateGroups.get(dk).times;
    const key = getCellKey(r);
    if (!tm.has(r.timeLabel)) tm.set(r.timeLabel, {});
    // Allow multiple sessions per section cell (area-mode may produce parallel sessions)
    const cellMap = tm.get(r.timeLabel);
    if (!cellMap[key]) cellMap[key] = [];
    cellMap[key].push(r);
  });

  // 5. Remove time slots where ALL visible sections are empty
  for (const [dk, group] of dateGroups) {
    for (const [tl, sessMap] of group.times) {
      const hasAny = sections.some(s => sessMap[s] && sessMap[s].length);
      if (!hasAny) group.times.delete(tl);
    }
    if (group.times.size === 0) dateGroups.delete(dk);
  }

  if (!dateGroups.size) {
    tbody.innerHTML = `<tr><td colspan="${numCols}" class="empty-state">No sessions match the current filters.</td></tr>`;
    return;
  }

  // 6. Render with rowspan on Date & Day
  tbody.innerHTML = [...dateGroups.values()].map(({ date, day, times }) => {
    const timeEntries = [...times.entries()];
    const rowspan = timeEntries.length;

    return timeEntries.map(([timeLabel, sessMap], tIdx) => {
      const dateDayCells = tIdx === 0 ? `
        <td rowspan="${rowspan}" class="tt-sticky-0" style="vertical-align:middle;border-right:1px solid var(--border);font-family:var(--font-m);font-size:.8rem">${date}</td>
        <td rowspan="${rowspan}" class="tt-sticky-1" style="vertical-align:middle;border-right:1px solid var(--border);color:var(--text2);font-size:.82rem">${day}</td>` : '';

      const sectionCells = sections.map(sec => {
        const cell = sessMap[sec];
        if (!cell) return `<td style="color:var(--muted);text-align:center;font-size:.8rem">—</td>`;
        // cell is an array of one or more sessions
        const first = cell[0];
        const col = getCourseColor(first.courseCode);
        let line1 = '';
        let line2 = '';
        if (TTView.mode === 'section') {
          line1 = cell.map(x => x.courseShort || x.courseCode).join(' / ');
          line2 = cell.map(x => x.facultyShort || x.faculty).join(' / ');
        }
        else if (TTView.mode === 'course') {
          line1 = cell.map(x => x.section).join(' / ');
          line2 = cell.map(x => x.facultyShort || x.faculty).join(' / ');
        }
        else if (TTView.mode === 'faculty') {
          line1 = cell.map(x => x.courseShort || x.courseCode).join(' / ');
          line2 = cell.map(x => x.section).join(' / ');
        }
        return `<td style="text-align:center">
          <span class="course-chip"
                style="background:${col}22;color:${col};border:1px solid ${col}44">
            ${line1}
          </span>
          <span style="color:var(--text2);font-size:.75rem;display:block;margin-top:.2rem">
            ${line2}
          </span>
        </td>`;
      });

      return `<tr>
        ${dateDayCells}
        <td class="tt-sticky-2" style="font-family:var(--font-m);font-size:.78rem;color:var(--text2)">${timeLabel}</td>
        ${sectionCells.join('')}
      </tr>`;
    }).join('');
  }).join('');
}

function updateStaleWarning() {
  const meta = State.timetableMeta;
  if(!meta) return;
  const configEdit = get(KEY.configEdit);
  const stale = isConfigNewerThanTimetable(configEdit, meta.timestamp);
  const el = document.getElementById('tt-stale-warn');
  if(el) el.style.display = stale?'flex':'none';
}

// TIMETABLE VERIFICATION
async function verifyTimetable() {
  if (!State.timetable || !State.timetable.length) {
    toast('No timetable to verify.', 'warning'); return;
  }
  const btn = document.getElementById('verify-btn');
  btn.disabled = true; btn.textContent = 'Verifying…';
  try {
    // Sends all semesters config + the generated timetable
    const payload = { ...getConfigData(), timetable: State.timetable };
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    btn.disabled = false; btn.innerHTML = '✓ Verify Timetable';
    if (data.status === 'error') { toast(data.message, 'error'); return; }
    renderVerifyResults(data);
    document.getElementById('verify-results').style.display = 'block';
    document.getElementById('verify-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch(e) {
    btn.disabled = false; btn.innerHTML = '✓ Verify Timetable';
    toast('Verification request failed.', 'error');
    console.error(e);
  }
}

function renderVerifyResults(data) {
  const wrap = document.getElementById('verify-results');
  wrap.style.display = 'block';
  wrap.scrollIntoView({behavior:'smooth', block:'start'});

  // stat cards
  const sessionViol = data.sessionCount.reduce((sum, r) => sum + r.scheduled, 0);
  const requiredSessionCount = data.sessionCount.reduce((sum, r) => sum + r.required, 0);
  const slotViol = data.slotAssignmentViolations.length;
  const loadViol = data.facultyLoad.length;
  const consec = data.consecutiveViolationsPenalty;
  const clone = data.cloneViolations.length;
  const spacing = data.spacingViolations.length;
  const unavail = data.unavailViolations.length;
  const conflict = data.conflictViolations.length;
  const spread = data.spreadingViolationsPenalty;

  const stats = [
    {val:sessionViol===0?'✓':`${sessionViol} / ${requiredSessionCount}`, label:'Session Count', cls:sessionViol===0?'ok':'fail'},
    {val:loadViol===0?'✓':loadViol, label:'Load Violations', cls:loadViol===0?'ok':'fail'},
    {val:slotViol===0?'✓':slotViol, label:'Slot Violations', cls:slotViol===0?'ok':'fail'},
    {val:clone===0?'✓':clone, label:'Cloning Violations', cls:clone===0?'ok':'fail'},
    {val:spacing===0?'✓':spacing, label:'Spacing Violations', cls:spacing===0?'ok':'fail'},
    {val:unavail===0?'✓':unavail, label:'Unavailability', cls:unavail===0?'ok':'fail'},
    {val:conflict===0?'✓':conflict, label:'Course conflicts', cls:conflict===0?'ok':'fail'},
    {val:consec===0?'✓':consec, label:'Consecutive Violations', cls:consec===0?'ok':'fail'},
    {val:spread===0?'✓':spread, label:'Spreading Violations', cls:spread===0?'ok':'fail'}
  ]
  document.getElementById('verify-stats').innerHTML = stats.map(s=>`<div class="verify-stat ${s.cls}">
    <div class="vs-val">${s.val}</div>
    <div class="vs-label">${s.label}</div>
  </div>`).join('');

  let html = '';

  // 1. Session count violations
  if(sessionViol > 0){
    html += `
    <div class="verify-section">
      <div class="verify-section-title">
        ❌ Session Count Violations
      </div>

      <div class="table-wrap" style="max-height:280px">
        <table class="data-table">

          <thead>
            <tr>
              <th>Section</th>
              <th>Course</th>
              <th>Required</th>
              <th>Scheduled</th>
            </tr>
          </thead>

          <tbody>

            ${data.sessionCount.map(r=>`

              <tr>

                <td>
                  <span class="badge badge-gold">${r.section}</span>
                </td>

                <td>
                  <span class="badge badge-blue"
                    style="font-family:var(--font-m)">
                    ${r.course}
                  </span>
                </td>

                <td style="text-align:center">
                  ${r.required}
                </td>

                <td style="text-align:center">
                  <span class="badge badge-red">
                    ${r.scheduled}
                  </span>
                </td>

              </tr>

            `).join('')}

          </tbody>

        </table>
      </div>
    </div>
    `;
  }

  // 2. Faculty load violations
  if(loadViol > 0){
    html += `
    <div class="verify-section">

      <div class="verify-section-title">
        ❌ Faculty Daily Load Violations
      </div>

      <div class="table-wrap" style="max-height:280px">

        <table class="data-table">

          <thead>
            <tr>
              <th>Faculty</th>
              <th>Date</th>
              <th>Sessions</th>
              <th>Max Allowed</th>
            </tr>
          </thead>

          <tbody>

            ${data.facultyLoad.map(r=>`

              <tr>

                <td>${r.faculty}</td>

                <td style="font-family:var(--font-m);font-size:.8rem">
                  ${r.date}
                </td>

                <td style="text-align:center">
                  <span class="badge badge-red">
                    ${r.sessions}
                  </span>
                </td>

                <td style="text-align:center">
                  ${r.maxAllowed}
                </td>

              </tr>

            `).join('')}

          </tbody>

        </table>

      </div>

    </div>
    `;
  }

  // 3. Slot assignment violations
  if(slotViol > 0){
    html += `
    <div class="verify-section">

      <div class="verify-section-title">
        ❌ Slot Assignment Violations
      </div>

      <div class="table-wrap">

        <table class="data-table">

          <thead>
            <tr>
              <th>Section</th>
              <th>Date</th>
              <th>Time</th>
              <th>Assigned Courses</th>
              <th>Count</th>
            </tr>
          </thead>

          <tbody>

            ${data.slotAssignmentViolations.map(r=>`

              <tr>

                <td>
                  <span class="badge badge-gold">
                    ${r.section}
                  </span>
                </td>

                <td style="font-family:var(--font-m)">
                  ${r.date}
                </td>

                <td style="font-family:var(--font-m)">
                  ${r.fromTime} - ${r.toTime}
                </td>

                <td>
                  ${r.assignedCourses.join(', ')}
                </td>

                <td style="text-align:center">
                  <span class="badge badge-red">
                    ${r.count}
                  </span>
                </td>

              </tr>

            `).join('')}

          </tbody>

        </table>

      </div>

    </div>
    `;
  }

  // 4. Cloning violations
  if(clone>0){
    html += `<div class="verify-section"><div class="verify-section-title">❌ Faculty Cloning Violations</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Faculty</th><th>Date</th><th>Time</th><th>Sections</th></tr></thead>
      <tbody>${data.cloneViolations.map(r=>`<tr><td>${r.faculty}</td><td>${r.date}</td><td>${r.time}</td><td>${r.sections.join(', ')}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  }

  // 5. Spacing violations
  if(spacing>0){
    html += `<div class="verify-section"><div class="verify-section-title">❌ Course Spacing Violations (same course twice in one day)</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Section</th><th>Course</th><th>Date</th><th>Count</th></tr></thead>
      <tbody>${data.spacingViolations.map(r=>`<tr><td>${r.section}</td><td>${r.course}</td><td>${r.date}</td><td>${r.count}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  }

  // 6. Faculty unavailability violations
  if(unavail>0){
    html += `<div class="verify-section"><div class="verify-section-title">❌ Unavailability Violations</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Faculty</th><th>Date</th><th>Section</th><th>Course</th></tr></thead>
      <tbody>${data.unavailViolations.map(r=>`<tr><td>${r.faculty}</td><td>${r.date}</td><td>${r.section}</td><td>${r.course}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  }

  // 7. Course conflict violations
  if(conflict > 0){
    html += `
    <div class="verify-section">

      <div class="verify-section-title">
        ❌ Course Conflict Violations
      </div>

      <div class="table-wrap">

        <table class="data-table">

          <thead>
            <tr>
              <th>Group</th>
              <th>Date</th>
              <th>Time</th>
              <th>Courses</th>
              <th>Sections</th>
              <th>Count</th>
            </tr>
          </thead>

          <tbody>

            ${data.conflictViolations.map(r=>`

              <tr>

                <td>
                  <span class="badge badge-red">
                    ${r.groupIndex}
                  </span>
                </td>

                <td style="font-family:var(--font-m)">
                  ${r.date}
                </td>

                <td style="font-family:var(--font-m)">
                  ${r.time}
                </td>

                <td>
                  ${r.courses.join(', ')}
                </td>

                <td>
                  ${r.sections.join(', ')}
                </td>

                <td style="text-align:center">
                  <span class="badge badge-red">
                    ${r.count}
                  </span>
                </td>

              </tr>

            `).join('')}

          </tbody>

        </table>

      </div>

    </div>
    `;
  }
  
  // 8. Consecutive violations
  if (consec>0) {
    html += `
    <div class="verify-section">
      <div class="verify-section-title">❌ Consecutive Violations — ${consec} found</div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Section</th><th>Course</th><th>Window Start</th><th>Window End</th><th>Length</th></tr></thead>
          <tbody>${data.consecutiveViolations.map(r=>`<tr>
            <td><span class="badge badge-gold">${r.section || 'All Areas'}</span></td>
            <td><span class="badge badge-blue" style="font-family:var(--font-m)">${r.course}</span></td>
            <td style="font-family:var(--font-m);font-size:.8rem">${r.periodStart}</td>
            <td style="font-family:var(--font-m);font-size:.8rem">${r.periodEnd}</td>
            <td style="text-align:center"><span class="badge badge-red">${r.windowSize}</span></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    `;
  }

  // 9. Week distribution heatmap
  html += `<div class="verify-section">
    <div class="verify-section-title">📊 Week-Course Distribution</div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem" id="hm-section-btns"></div>
    <div id="hm-content"></div>
  </div>`;

  document.getElementById('verify-details').innerHTML = html;

  // Build heatmaps
  const sections = Object.keys(data.weekDistribution).sort();
  const hmbtnEl = document.getElementById('hm-section-btns');
  const hmContent = document.getElementById('hm-content');
  sections.forEach((s,i)=>{
    const btn=document.createElement('button');
    btn.className='section-filter-btn'+(i===0?' active':'');
    btn.textContent=isAreaMode() ? 'Area ' + s : 'Section ' + s;
    btn.addEventListener('click',()=>{
      hmbtnEl.querySelectorAll('.section-filter-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderHeatmap(data.weekDistribution[s], hmContent);
    });
    hmbtnEl.appendChild(btn);
  });
  if(sections.length) renderHeatmap(data.weekDistribution[sections[0]], hmContent);
}

function renderHeatmap(dist, container) {
  const {weeks, weekLabels, courses, data: mat} = dist;
  // Backward compatible: older payloads only contain numeric ISO week numbers.
  const headers = (Array.isArray(weekLabels) && weekLabels.length === weeks.length)
    ? weekLabels
    : weeks.map(w => `W${w}`);
  let t = `<div style="overflow-x:auto"><table class="heatmap-table">
    <thead><tr><th class="hm-sticky-col hm-sticky-head">Course \\ Week</th>${headers.map(w=>`<th>${w}</th>`).join('')}</tr></thead>
    <tbody>${courses.map((c,ci)=>`<tr>
      <td class="hm-sticky-col">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${getCourseColor(c)};margin-right:.35rem;vertical-align:middle"></span>${c}
      </td>
      ${mat.map(row=>{
        const v=row[ci]||0;
        const cls=v===0?'hm-0':v===1?'hm-1':v>=2?'hm-warn':'hm-1';
        return `<td class="${cls}">${v||'·'}</td>`;
      }).join('')}
    </tr>`).join('')}
    </tbody>
  </table></div>
  <p style="font-size:.73rem;color:var(--muted);margin-top:.5rem">
    <span class="badge badge-green" style="margin-right:.3rem">1</span> = 1 session &nbsp;
    <span class="badge badge-red" style="margin-right:.3rem">2+</span> = multiple (spacing issue check) &nbsp;
    · = no session
  </p>
  <p style="font-size:.73rem;color:var(--muted);margin-top:.2rem">
    NOTE: Weeks are shown in ISO year-week format (YYYY-Www) for chronological clarity across year boundaries.
  </p>
  `;
  container.innerHTML = t;
}

// ─── CONSTRAINT HELPERS (per-card, semId-scoped) ──────────────

function defaultConstraintConfig() {
  return {
    facultyUnavailability: true,
    courseConflicts: true,
    consecutiveRule: { enabled:true, maxConsecutive:2, periodUnit:'weeks', resetBoundary:'month' },
    spreadingRule:   { enabled:true, weight:0.1 },
  };
}

function toggleConsecDetail(semId, enabled) {
  const el = document.getElementById(`${semId}-c-consec-detail`);
  if (el) el.style.display = enabled ? 'block' : 'none';
}

function toggleSpreadDetail(semId, enabled) {
  const el = document.getElementById(`${semId}-c-spread-detail`);
  if (el) el.style.display = enabled ? 'block' : 'none';
}

function saveConstraintConfig(semId) {
  const sem = getSem(semId);
  if (!sem) return;
  const g = id => document.getElementById(`${semId}-${id}`);
  const cfg = {
    facultyUnavailability: g('c-unavail').checked,
    courseConflicts:       g('c-conflicts').checked,
    consecutiveRule: {
      enabled:        g('c-consec-enabled').checked,
      maxConsecutive: parseInt(g('c-consec-max').value)||2,
      periodUnit:     g('c-consec-unit').value,
      resetBoundary:  g('c-consec-boundary').value,
    },
    spreadingRule: {
      enabled: g('c-spread-enabled').checked,
      weight:  parseFloat(g('c-spread-weight').value)||0.1,
    },
  };
  sem.constraintConfig = cfg;
  saveSemesters();
  toast('Constraint configuration saved.', 'success');
}

// ─── INIT ────────────────────────────────────────────────────
function init() {
  loadState();
  renderSemCards();
  refreshTimetableTab();
  // Modal button wiring
  const modalClose  = document.getElementById('modal-close');
  const modalCancel = document.getElementById('modal-cancel');
  const modalSave   = document.getElementById('modal-save');
  if (modalClose)  modalClose.addEventListener('click',  () => closeModal());
  if (modalCancel) modalCancel.addEventListener('click', () => closeModal());
  if (modalSave)   modalSave.addEventListener('click',   () => { if (typeof _modalSaveFn==='function') _modalSaveFn(); });
}
init();

// ─── EXPORT — one sheet per semester  +  separate Timetable sheet ───
function exportToExcel() {
  if (!State.semesters.length && (!State.timetable || !State.timetable.length)) {
    toast('Nothing to export yet.', 'warning'); return;
  }

  const wb = XLSX.utils.book_new();

  // helpers
  function setColWidths(ws, widths) { ws['!cols'] = widths.map(w => ({ wch: w })); }
  function freezeRow(ws)            { ws['!freeze'] = { xSplit: 0, ySplit: 1 }; }

  // Excel sheet name: max 31 chars, no \ / * ? [ ] :
  const reservedNames = new Set(['Timetable']);
  function safeSheetName(raw) {
    let s = (raw || 'Semester').replace(/[\\\/\*\?\[\]\:]/g, '_').slice(0, 28).trim();
    let name = s, n = 1;
    while (reservedNames.has(name)) name = s.slice(0, 24) + '_' + (n++);
    reservedNames.add(name);
    return name;
  }

  // ── One sheet per semester ────────────────────────────────────
  State.semesters.forEach(sem => {
    const cfg = sem.constraintConfig || defaultConstraintConfig();
    const aoa = []; // array-of-arrays (rows)

    // ── Identifier (first cell tells the importer this is a semester sheet) ──
    aoa.push(['##SEMESTER_CONFIG##']);

    // ── META ──
    aoa.push(['##META##']);
    aoa.push(['Semester Name',  sem.name]);
    aoa.push(['Teaching Start', sem.startDate  || '']);
    aoa.push(['Teaching End',   sem.endDate    || '']);
    aoa.push(['Config Mode',    sem.configMode || 'sections']);
    aoa.push([]);

    // ── SECTIONS ──
    aoa.push(['##SECTIONS##']);
    aoa.push(['Section Name', 'Weekday', 'From Time', 'To Time', 'Duration (hrs)']);
    sem.sections.forEach(s =>
      (s.slots || []).forEach(sl =>
        aoa.push([s.name, sl.weekday, sl.fromTime, sl.toTime, sl.duration])
      )
    );
    aoa.push([]);

    // ── AREAS ──
    aoa.push(['##AREAS##']);
    aoa.push(['Area Name', 'Short Name', 'Weekday', 'From Time', 'To Time', 'Duration (hrs)', 'Excluded Dates (comma-sep YYYY-MM-DD)']);
    sem.areas.forEach(area => {
      const excStr = (area.excludedDates || []).join(', ');
      (area.slots || []).forEach(sl =>
        aoa.push([area.name, area.shortName, sl.weekday, sl.fromTime, sl.toTime, sl.duration, excStr])
      );
    });
    aoa.push([]);

    // ── COURSES ──
    aoa.push(['##COURSES##']);
    aoa.push(['Course Code', 'Course Title', 'Short Title', 'Area Short Name',
              'Max Sessions/Month', 'Credit', 'Duration', 'Required Slots']);
    sem.courses.forEach(c =>
      aoa.push([
        c.code, c.title, c.shortTitle || '',
        c.areaShortName || '', c.maxSessionsPerMonth || '',
        c.credit, c.duration, c.requiredSlots,
      ])
    );
    aoa.push([]);

    // ── FACULTY ──
    aoa.push(['##FACULTY##']);
    aoa.push(['Full Name', 'Short Name', 'Max Load Per Day', 'Unavailable Slots (date|HH:MM-HH:MM;...)']);
    sem.faculty.forEach(f => {
      const slotsStr = Array.isArray(f.unavailableSlots)
        ? f.unavailableSlots.map(s => s.date + (s.fromTime ? '|' + s.fromTime + '-' + s.toTime : '')).join('; ')
        : (Array.isArray(f.unavailableDates) ? f.unavailableDates.join('; ') : '');
      aoa.push([f.fullName, f.shortName, f.maxLoadPerDay, slotsStr]);
    });
    aoa.push([]);

    // ── MAPPING ──
    // Unified columns: Section | Course Code | Faculty Short Name
    // Area-mode mappings leave Section blank.
    aoa.push(['##MAPPING##']);
    aoa.push(['Section', 'Course Code', 'Faculty Short Name']);
    sem.sectionMappings.forEach(m => aoa.push([m.section || '', m.courseCode, m.facultyShortName]));
    sem.areaMappings.forEach(m    => aoa.push(['',              m.courseCode, m.facultyShortName]));
    aoa.push([]);

    // ── CONFLICTS ──
    aoa.push(['##CONFLICTS##']);
    aoa.push(['Group', 'Courses', 'Sections']);
    sem.courseConflicts.forEach((g, i) =>
      aoa.push([i + 1, g.courses.join(', '), (g.sections || []).join(', ')])
    );
    aoa.push([]);

    // ── CONSTRAINTS ──
    aoa.push(['##CONSTRAINTS##']);
    aoa.push(['Setting', 'Value']);
    aoa.push(['facultyUnavailability',          cfg.facultyUnavailability]);
    aoa.push(['courseConflicts',                cfg.courseConflicts]);
    aoa.push(['consecutiveRule.enabled',        cfg.consecutiveRule.enabled]);
    aoa.push(['consecutiveRule.maxConsecutive', cfg.consecutiveRule.maxConsecutive]);
    aoa.push(['consecutiveRule.periodUnit',     cfg.consecutiveRule.periodUnit]);
    aoa.push(['consecutiveRule.resetBoundary',  cfg.consecutiveRule.resetBoundary]);
    aoa.push(['spreadingRule.enabled',          cfg.spreadingRule.enabled]);
    aoa.push(['spreadingRule.weight',           cfg.spreadingRule.weight]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    setColWidths(ws, [24, 22, 14, 14, 14, 12, 40]);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sem.name));
  });

  // ── TIMETABLE sheet (same pivoted structure as before) ───────
  if (State.timetable && State.timetable.length) {
    const tt         = State.timetable;
    const ttSections = [...new Set(tt.map(r => r.section))].sort();

    const pivotMap = new Map();
    tt.forEach(r => {
      const key = `${r.date}||${r.day}||${r.fromTime}||${r.toTime}`;
      if (!pivotMap.has(key))
        pivotMap.set(key, { date: r.date, day: r.day, fromTime: r.fromTime, toTime: r.toTime, cells: {} });
      const entry = pivotMap.get(key);
      if (!entry.cells[r.section]) entry.cells[r.section] = [];
      entry.cells[r.section].push(`${r.courseShort || r.courseCode} (${r.facultyShort || ''})`);
    });
    const pivotRows = [...pivotMap.values()]
      .sort((a, b) => a.date.localeCompare(b.date) || a.fromTime.localeCompare(b.fromTime));

    const ttHeader = ['Date', 'Day', 'From Time', 'To Time', ...ttSections];
    const ttRows   = pivotRows.map(p =>
      [p.date, p.day, p.fromTime, p.toTime, ...ttSections.map(s => p.cells[s] ? p.cells[s].join(' / ') : '')]
    );

    const wsTT = XLSX.utils.aoa_to_sheet([ttHeader, ...ttRows]);
    setColWidths(wsTT, [12, 10, 10, 10, ...ttSections.map(() => 10)]);
    freezeRow(wsTT);

    const meta = State.timetableMeta;
    if (meta) {
      XLSX.utils.sheet_add_aoa(wsTT, [
        [],
        ['__META__', 'Status',       meta.status],
        ['__META__', 'Generated At', meta.timestamp],
        ['__META__', 'Constraint',   meta.constraintType],
        ['__META__', 'Penalty',      meta.penalty],
      ], { origin: { r: ttRows.length + 3, c: 0 } });
    }
    XLSX.utils.book_append_sheet(wb, wsTT, 'Timetable');
  }

  const date  = new Date().toISOString().slice(0, 10);
  const fname = `Program_Timetable_Config_${date}.xlsx`;
  XLSX.writeFile(wb, fname);
  toast(`Exported → ${fname}`, 'success');
}

function getVisibleColumns() {
  const allCols = getTTColumns(State.timetable);

  return allCols.filter(c =>
    !ActiveFilters.section.size ||
    ActiveFilters.section.has(c)
  );
}
function exportVisibleTimetable() {

  const tt = State.timetable;

  if (!tt?.length) {
    toast('No timetable available.', 'warning');
    return;
  }

  const columns = getVisibleColumns();

  const filtered = tt.filter(r =>
    (!ActiveFilters.date.size || ActiveFilters.date.has(r.date)) &&
    (!ActiveFilters.day.size  || ActiveFilters.day.has(r.day)) &&
    (!ActiveFilters.time.size || ActiveFilters.time.has(r.timeLabel))
  );

  const pivotMap = new Map();

  filtered.forEach(r => {

    const key =
      `${r.date}||${r.day}||${r.timeLabel}`;

    if (!pivotMap.has(key)) {
      pivotMap.set(key,{
        date:r.date,
        day:r.day,
        time:r.timeLabel,
        cells:{}
      });
    }

    const columnKey = getCellKey(r);

    let value = '';

    if (TTView.mode === 'section') {
      value =
        `${r.courseShort || r.courseCode} (${r.facultyShort || r.faculty})`;
    }

    else if (TTView.mode === 'course') {
      value =
        `${r.section} (${r.facultyShort || r.faculty})`;
    }

    else {
      value =
        `${r.courseShort || r.courseCode} (${r.section})`;
    }

    const row = pivotMap.get(key);

    if (!row.cells[columnKey]) {
      row.cells[columnKey] = [];
    }

    row.cells[columnKey].push(value);
  });

  const rows = [...pivotMap.values()].filter(r =>
    columns.some(c =>
      r.cells[c] && r.cells[c].length
    )
  ).sort(
    (a,b) =>
      a.date.localeCompare(b.date) ||
      a.time.localeCompare(b.time)
  );

  const header = ['Date', 'Day', 'Time', ...columns];

  const aoa = [
    header,
    ...rows.map(r => [
      r.date,
      r.day,
      r.time,
      ...columns.map(c =>
        r.cells[c]
          ? r.cells[c].join(' / ')
          : ''
      )
    ])
  ];

  const wb = XLSX.utils.book_new();

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 16 }, ...columns.map(() => ({ wch: 20 }))];

  ws['!freeze'] = {xSplit: 0, ySplit: 1};

  XLSX.utils.book_append_sheet(wb, ws, 'Timetable');

  const modeLabel =
    TTView.mode === 'section'
      ? isAreaMode() ? 'Areas' : 'Sections'
      : TTView.mode === 'course' ? 'Courses' : 'Faculty';

  XLSX.writeFile(
    wb,
    `Timetable_${modeLabel}_${new Date().toISOString().slice(0,10)}.xlsx`
  );

  toast('Timetable exported.', 'success');
}

// IMPORT — Reads .xlsx, parses each sheet, stores to localStorage
function importFromExcel(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });

      // Read a sheet as array-of-arrays
      function toAoA(name) {
        const ws = wb.Sheets[name];
        return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) : [];
      }
      // Read a sheet as array-of-objects keyed by header row (legacy helper)
      function toObjects(name) {
        const aoa = toAoA(name);
        if (aoa.length < 2) return [];
        const hdr = aoa[0].map(h => String(h || '').trim());
        return aoa.slice(1)
          .map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] !== undefined ? r[i] : ''])))
          .filter(r => Object.values(r).some(v => v !== '' && v !== null && v !== undefined));
      }

      // ── Detect format ────────────────────────────────────────
      const semSheets = wb.SheetNames.filter(name => {
        if (name === 'Timetable') return false;
        const rows = toAoA(name);
        return rows.length > 0 && String(rows[0][0] || '').trim() === '##SEMESTER_CONFIG##';
      });
      const isNewFormat = semSheets.length > 0;
      const isLegacy = !isNewFormat &&
        wb.SheetNames.some(n => ['Sections','Areas','Courses','Faculty','Mapping','Meta'].includes(n));

      if (!isNewFormat && !isLegacy) {
        toast('No recognizable semester data found in this file.', 'error'); return;
      }

      // ── Parse semesters ──────────────────────────────────────
      const importedSemesters = isNewFormat
        ? semSheets.map(name => _parseSemesterSheet(toAoA(name), name))
        : [_parseLegacySheets(toObjects, wb.SheetNames)];

      const validSemesters = importedSemesters.filter(Boolean);
      if (!validSemesters.length) {
        toast('No valid semester data could be parsed.', 'error'); return;
      }

      // ── Parse timetable (same for both formats) ──────────────
      const { timetable, meta } = _parseTimetableSheet(toAoA('Timetable'), validSemesters);

      // ── Apply to state ───────────────────────────────────────
      State.semesters = validSemesters;
      saveSemesters();
      expandedSemId = null;

      if (timetable.length) {
        State.timetable     = timetable;
        State.timetableMeta = meta;
        set(KEY.timetable,     State.timetable);
        set(KEY.timetableMeta, State.timetableMeta);
      }

      renderSemCards();
      refreshTimetableTab();
      touchConfig();

      const parts = [
        validSemesters.length + ' semester(s): ' + validSemesters.map(s => `"${s.name}"`).join(', '),
        timetable.length ? timetable.length + ' timetable sessions' : null,
      ].filter(Boolean);
      toast('Imported: ' + parts.join(' | '), 'success');

    } catch(err) {
      toast('Import failed: ' + err.message, 'error');
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ── Parse one new-format semester sheet (array-of-arrays) ── */
function _parseSemesterSheet(rows, sheetName) {
  const _toBool = v => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number')  return v !== 0;
    if (typeof v === 'string')  return v.toLowerCase() === 'true';
    return false;
  };

  // Scan rows into named sections { META: [[row],...], SECTIONS: [...], ... }
  const sections = {};
  let cur = null;
  rows.forEach(row => {
    const first = String(row[0] || '').trim();
    if (first === '##SEMESTER_CONFIG##') { cur = null; return; }
    if (/^##[A-Z_]+##$/.test(first)) {
      cur = first.slice(2, -2); // "META", "SECTIONS", …
      if (!sections[cur]) sections[cur] = [];
      return;
    }
    if (cur && !row.every(c => String(c || '').trim() === ''))
      sections[cur].push(row.map(c => String(c || '').trim()));
  });

  const getRows  = key => sections[key] || [];
  const dataRows = key => getRows(key).slice(1);   // first row after marker is header → skip

  // META
  const metaKV = Object.fromEntries(getRows('META').map(r => [r[0], r[1]]));
  const sem = {
    id:         generateSemId(),
    name:       metaKV['Semester Name'] || sheetName,
    startDate:  metaKV['Teaching Start'] || '',
    endDate:    metaKV['Teaching End']   || '',
    configMode: metaKV['Config Mode']    || 'sections',
    sections: [], areas: [], courses: [], faculty: [],
    sectionMappings: [], areaMappings: [], courseConflicts: [],
    constraintConfig: defaultConstraintConfig(),
  };

  // SECTIONS: Section Name | Weekday | From Time | To Time | Duration
  const secMap = new Map();
  dataRows('SECTIONS').filter(r => r[0]).forEach(r => {
    const [name, weekday, fromTime, toTime, duration] = r;
    if (!name) return;
    if (!secMap.has(name)) secMap.set(name, { name, slots: [] });
    if (weekday) secMap.get(name).slots.push({ weekday, fromTime, toTime, duration: parseFloat(duration) || 2.5 });
  });
  sem.sections = [...secMap.values()];

  // AREAS: Area Name | Short Name | Weekday | From Time | To Time | Duration | Excluded Dates
  const areaMap = new Map();
  dataRows('AREAS').filter(r => r[1]).forEach(r => {
    const [name, shortName, weekday, fromTime, toTime, duration, excStr] = r;
    if (!shortName) return;
    if (!areaMap.has(shortName)) {
      const excludedDates = excStr ? excStr.split(',').map(d => d.trim()).filter(Boolean) : [];
      areaMap.set(shortName, { name: name || shortName, shortName, slots: [], excludedDates });
    }
    if (weekday) areaMap.get(shortName).slots.push({ weekday, fromTime, toTime, duration: parseFloat(duration) || 2.5 });
  });
  sem.areas = [...areaMap.values()];

  // COURSES: Code|Title|Short|AreaShort|MaxMonthly|Credit|Duration|ReqSlots
  sem.courses = dataRows('COURSES').filter(r => r[0] && r[1]).map(r => ({
    code: r[0], title: r[1], shortTitle: r[2] || '',
    areaShortName:       r[3] || '',
    maxSessionsPerMonth: parseInt(r[4])   || 0,
    credit:              parseFloat(r[5]) || 0,
    duration:            parseFloat(r[6]) || 0,
    requiredSlots:       parseInt(r[7])   || 0,
  }));

  // FACULTY: Full Name | Short Name | Max Load | Slots String
  sem.faculty = dataRows('FACULTY').filter(r => r[0] && r[1]).map(r => {
    const [fullName, shortName, maxLoad, slotsStr] = r;
    const unavailableSlots = [];
    if (slotsStr) {
      slotsStr.split(';').forEach(entry => {
        const t = entry.trim(); if (!t) return;
        const pi = t.indexOf('|');
        if (pi === -1) {
          unavailableSlots.push({ date: t, fromTime: '', toTime: '' });
        } else {
          const date = t.slice(0, pi);
          const [fromTime = '', toTime = ''] = t.slice(pi + 1).split('-');
          unavailableSlots.push({ date, fromTime, toTime });
        }
      });
    }
    return { fullName, shortName, maxLoadPerDay: parseInt(maxLoad) || 2, unavailableSlots };
  });

  // MAPPING: Section(blank=area) | Course Code | Faculty Short Name
  dataRows('MAPPING').filter(r => r[1] && r[2]).forEach(r => {
    const [section, courseCode, facultyShortName] = r;
    if (section) sem.sectionMappings.push({ section, courseCode, facultyShortName });
    else         sem.areaMappings.push({ courseCode, facultyShortName });
  });

  // CONFLICTS: Group | Courses | Sections
  dataRows('CONFLICTS').filter(r => r[1]).forEach(r => {
    const courses  = r[1].split(',').map(c => c.trim()).filter(Boolean);
    const sections = r[2] ? r[2].split(',').map(s => s.trim()).filter(Boolean) : [];
    if (courses.length >= 2) sem.courseConflicts.push({ courses, sections });
  });

  // CONSTRAINTS: Setting | Value
  const csRows = dataRows('CONSTRAINTS').filter(r => r[0]);
  if (csRows.length) {
    const kv = Object.fromEntries(csRows.map(r => [r[0], r[1]]));
    sem.constraintConfig = {
      facultyUnavailability: _toBool(kv['facultyUnavailability'] ?? true),
      courseConflicts:       _toBool(kv['courseConflicts']       ?? true),
      consecutiveRule: {
        enabled:        _toBool(kv['consecutiveRule.enabled']         ?? true),
        maxConsecutive: parseInt(kv['consecutiveRule.maxConsecutive'])  || 2,
        periodUnit:     String(kv['consecutiveRule.periodUnit']   || 'weeks').trim(),
        resetBoundary:  String(kv['consecutiveRule.resetBoundary'] || 'month').trim(),
      },
      spreadingRule: {
        enabled: _toBool(kv['spreadingRule.enabled'] ?? true),
        weight:  parseFloat(kv['spreadingRule.weight']) || 0.1,
      },
    };
  }

  return sem;
}

/* ── Parse old-format sheets into a single semester ── */
function _parseLegacySheets(toObjects, sheetNames) {
  const _toBool = v => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number')  return v !== 0;
    if (typeof v === 'string')  return v.toLowerCase() === 'true';
    return false;
  };

  const sem = {
    id: generateSemId(), name: 'Imported Semester',
    startDate: '', endDate: '', configMode: 'sections',
    sections: [], areas: [], courses: [], faculty: [],
    sectionMappings: [], areaMappings: [], courseConflicts: [],
    constraintConfig: defaultConstraintConfig(),
  };

  // Meta sheet
  toObjects('Meta').forEach(r => {
    const vals = Object.values(r);
    const k = String(vals[0] || '').trim();
    const v = String(vals[1] || '').trim();
    if (k === 'Teaching Start') sem.startDate  = v;
    if (k === 'Teaching End')   sem.endDate    = v;
    if (k === 'Configuration Mode' || k === 'Config Mode') sem.configMode = v;
  });

  // Infer mode from which sheets exist
  if (sheetNames.includes('Areas') && !sheetNames.includes('Sections')) sem.configMode = 'areas';

  // Sections
  const secMap = new Map();
  toObjects('Sections').forEach(r => {
    const name = String(r['Section Name'] || '').trim(); if (!name) return;
    if (!secMap.has(name)) secMap.set(name, { name, slots: [] });
    const weekday  = String(r['Weekday']       || '').trim();
    const fromTime = String(r['From Time']     || '').trim();
    const toTime   = String(r['To Time']       || '').trim();
    const duration = parseFloat(r['Duration (hrs)']) || 2.5;
    if (weekday) secMap.get(name).slots.push({ weekday, fromTime, toTime, duration });
  });
  sem.sections = [...secMap.values()];

  // Areas
  const areaMap = new Map();
  toObjects('Areas').forEach(r => {
    const sn = String(r['Short Name'] || '').trim(); if (!sn) return;
    if (!areaMap.has(sn)) {
      const excStr = String(r['Excluded Dates (YYYY-MM-DD)'] || r['Excluded Dates (YYYY-MM-DD comma-sep)'] || '').trim();
      const excludedDates = excStr ? excStr.split(',').map(d => d.trim()).filter(Boolean) : [];
      areaMap.set(sn, { name: String(r['Area Name'] || sn).trim(), shortName: sn, slots: [], excludedDates });
    }
    const weekday  = String(r['Weekday']   || '').trim();
    const fromTime = String(r['From Time'] || '').trim();
    const toTime   = String(r['To Time']   || '').trim();
    const duration = parseFloat(r['Duration (hrs)']) || 2.5;
    if (weekday) areaMap.get(sn).slots.push({ weekday, fromTime, toTime, duration });
  });
  sem.areas = [...areaMap.values()];

  // Courses
  sem.courses = toObjects('Courses').map(r => {
    const code  = String(r['Course Code']  || '').trim();
    const title = String(r['Course Title'] || '').trim();
    if (!code || !title) return null;
    return {
      code, title,
      shortTitle:          String(r['Short Title']          || '').trim(),
      areaShortName:       String(r['Area Short Name']      || '').trim(),
      maxSessionsPerMonth: parseInt(r['Max Sessions / Month']) || 0,
      credit:              parseFloat(r['Credit'])    || 0,
      duration:            parseFloat(r['Duration'])  || 0,
      requiredSlots:       parseInt(r['Required Slots']) || 0,
    };
  }).filter(Boolean);

  // Faculty
  sem.faculty = toObjects('Faculty').map(r => {
    const fullName  = String(r['Full Name']  || '').trim();
    const shortName = String(r['Short Name'] || '').trim();
    if (!fullName || !shortName) return null;
    const slotsStr = String(
      r['Unavailable Slots (YYYY-MM-DD|HH:MM-HH:MM;...)'] ||
      r['Unavailable Slots (date|HH:MM-HH:MM;...)']       || ''
    ).trim();
    const unavailableSlots = [];
    if (slotsStr) {
      slotsStr.split(';').forEach(entry => {
        const t = entry.trim(); if (!t) return;
        const pi = t.indexOf('|');
        if (pi === -1) {
          unavailableSlots.push({ date: t, fromTime: '', toTime: '' });
        } else {
          const date = t.slice(0, pi);
          const [fromTime = '', toTime = ''] = t.slice(pi + 1).split('-');
          unavailableSlots.push({ date, fromTime, toTime });
        }
      });
    }
    return { fullName, shortName, maxLoadPerDay: parseInt(r['Max Load Per Day']) || 2, unavailableSlots };
  }).filter(Boolean);

  // Mapping (legacy may have Section or not)
  toObjects('Mapping').forEach(r => {
    const section          = String(r['Section']            || '').trim();
    const courseCode       = String(r['Course Code']        || '').trim();
    const facultyShortName = String(r['Faculty Short Name'] || '').trim();
    if (!courseCode || !facultyShortName) return;
    if (section) sem.sectionMappings.push({ section, courseCode, facultyShortName });
    else         sem.areaMappings.push({ courseCode, facultyShortName });
  });

  // Conflicts
  toObjects('Conflicts').forEach(r => {
    const coursesStr  = String(r['Courses']  || '').trim();
    const sectionsStr = String(r['Sections'] || '').trim();
    if (!coursesStr) return;
    const courses  = coursesStr.split(',').map(c => c.trim()).filter(Boolean);
    const sections = sectionsStr ? sectionsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (courses.length >= 2) sem.courseConflicts.push({ courses, sections });
  });

  // Constraints
  const csRows = toObjects('Constraints');
  if (csRows.length) {
    const kv = Object.fromEntries(
      csRows.filter(r => r['Setting']).map(r => [String(r['Setting']).trim(), r['Value']])
    );
    sem.constraintConfig = {
      facultyUnavailability: _toBool(kv['facultyUnavailability'] ?? true),
      courseConflicts:       _toBool(kv['courseConflicts']       ?? true),
      consecutiveRule: {
        enabled:        _toBool(kv['consecutiveRule.enabled']         ?? true),
        maxConsecutive: parseInt(kv['consecutiveRule.maxConsecutive'])  || 2,
        periodUnit:     String(kv['consecutiveRule.periodUnit']   || 'weeks').trim(),
        resetBoundary:  String(kv['consecutiveRule.resetBoundary'] || 'month').trim(),
      },
      spreadingRule: {
        enabled: _toBool(kv['spreadingRule.enabled'] ?? true),
        weight:  parseFloat(kv['spreadingRule.weight']) || 0.1,
      },
    };
  }

  return sem;
}

/* ── Parse the Timetable sheet (identical structure for both formats) ── */
function _parseTimetableSheet(rows, importedSemesters) {
  const result = { timetable: [], meta: null };
  if (!rows.length || rows.length < 2) return result;

  // Build lookup maps across all imported semesters
  const courseByShort = {}, courseByCode = {}, facultyByShort = {};
  (importedSemesters || []).forEach(sem => {
    (sem.courses || []).forEach(c => {
      if (c.shortTitle) courseByShort[c.shortTitle] = c;
      courseByCode[c.code] = c;
    });
    (sem.faculty || []).forEach(f => { facultyByShort[f.shortName] = f; });
  });

  const header    = rows[0].map(h => String(h || '').trim());
  const fixedCols = new Set(['Date', 'Day', 'From Time', 'To Time']);
  const meta      = {};

  rows.slice(1).forEach(row => {
    const obj = Object.fromEntries(header.map((h, i) => [h, String(row[i] || '').trim()]));

    // Metadata sentinels
    if (obj['Date'] === '__META__') {
      const k = obj['Day'], v = obj['From Time'];
      if (k === 'Status')       meta.status         = v;
      if (k === 'Generated At') meta.timestamp       = normalizeTimestamp(v) || v;
      if (k === 'Constraint')   meta.constraintType  = v;
      if (k === 'Penalty')      meta.penalty         = v;
      return;
    }
    if (!obj['Date']) return;

    const date      = obj['Date'];
    const day       = obj['Day'];
    const fromTime  = obj['From Time'];
    const toTime    = obj['To Time'];
    const timeLabel = `${fromTime} - ${toTime}`;

    Object.keys(obj).filter(col => !fixedCols.has(col)).forEach(col => {
      const cellVal = obj[col]; if (!cellVal) return;
      const section = col.trim();

      cellVal.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean).forEach(part => {
        const match      = part.match(/^(.+?)\s*\((.+)\)$/);
        const rawShort   = match ? match[1].trim() : part;
        const facShort   = match ? match[2].trim() : '';
        const course     = courseByShort[rawShort] || courseByCode[rawShort] || null;
        const courseCode  = course ? course.code       : rawShort;
        const courseTitle = course ? course.title      : rawShort;
        const courseShort = course ? course.shortTitle : rawShort;
        const facObj      = facultyByShort[facShort]  || null;
        const faculty     = facObj ? facObj.fullName   : facShort;
        result.timetable.push({
          date, day, fromTime, toTime, timeLabel,
          section, courseCode, courseTitle, courseShort,
          facultyShort: facShort, faculty,
        });
      });
    });
  });

  result.meta = Object.keys(meta).length
    ? meta
    : (result.timetable.length
        ? { status: 'imported', timestamp: utcNowIso(), constraintType: 'imported', penalty: '?' }
        : null);

  return result;
}

// WIRE UP BUTTONS
// ── Import button — updated hasData check ──
document.getElementById('import-btn').addEventListener('click', () => {
  const hasData = State.semesters.length || State.timetable?.length;
  if (hasData) {
    confirm2(
      'Import & Overwrite',
      'Importing will replace all current semester configurations and timetable data. Continue?',
      () => document.getElementById('import-file-input').click()
    );
  } else {
    document.getElementById('import-file-input').click();
  }
});

document.getElementById('import-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) { importFromExcel(file); e.target.value = ''; }
});

document.getElementById('export-btn').addEventListener('click', exportToExcel);

// Reset button
document.getElementById('reset-btn').addEventListener('click', () => {
  confirm2(
    'Reset All Data',
    'This will permanently delete all semester configurations and the generated timetable. This cannot be undone.',
    () => {
      Object.values(KEY).forEach(k => localStorage.removeItem(k));
      location.reload();
    }
  );
});
