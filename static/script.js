// STORAGE & STATE
const KEY = {
  sections:'program_sections', courses:'program_courses',
  faculty:'program_faculty', mappings:'program_mappings',
  startDate:'program_startDate', endDate:'program_endDate',
  timetable:'program_timetable', timetableMeta:'program_timetableMeta',
  configEdit:'program_configLastEdit', conflicts: 'program_conflicts',
};
const get = k => { try{ return JSON.parse(localStorage.getItem(k)) }catch{ return null } };
const set = (k,v) => localStorage.setItem(k, JSON.stringify(v));
const remove = k => localStorage.removeItem(k);

function touchConfig() {
  set(KEY.configEdit, new Date().toISOString());
  updateStaleWarning();
}

let State = {
  sections: [], courses: [], faculty: [], mappings: [], courseConflicts: [],
  startDate:'', endDate:'',
  timetable: null, timetableMeta: null,
};

function loadState() {
  State.sections    = get(KEY.sections)     || [];
  State.courses     = get(KEY.courses)      || [];
  State.faculty     = get(KEY.faculty)      || [];
  State.mappings    = get(KEY.mappings)     || [];
  State.startDate   = get(KEY.startDate)    || '';
  State.endDate     = get(KEY.endDate)      || '';
  State.timetable   = get(KEY.timetable)    || null;
  State.timetableMeta = get(KEY.timetableMeta) || null;
  State.courseConflicts = get(KEY.conflicts) || [];
}

function saveSection()  { set(KEY.sections, State.sections); touchConfig(); }
function saveCourse()   { set(KEY.courses,  State.courses);  touchConfig(); }
function saveFaculty()  { set(KEY.faculty,  State.faculty);  touchConfig(); }
function saveMapping()  { set(KEY.mappings, State.mappings); touchConfig(); }

// TOAST
function toast(msg, type='info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = {success:'✓', error:'✕', warning:'⚠', info:'ℹ'};
  el.innerHTML = `<span>${icons[type]||'ℹ'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.style.animation='fadeOut .25s ease forwards'; setTimeout(()=>el.remove(),250); }, 3000);
}

// TABS
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
    if(btn.dataset.tab==='timetable') refreshTimetableTab();
  });
});

document.querySelectorAll('.subtab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subtab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.subtab-content').forEach(t=>t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('subtab-'+btn.dataset.subtab).classList.add('active');
  });
});

// MODAL
let _modalSaveFn = null;
function openModal(title, bodyHTML, saveFn) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  _modalSaveFn = saveFn;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  _modalSaveFn = null;
}
function showModalError(msg) {
  let el = document.getElementById('modal-err');
  if(!el){ el=document.createElement('div'); el.id='modal-err'; el.className='modal-error'; document.getElementById('modal-body').prepend(el); }
  el.textContent = msg; el.classList.add('show');
}
function clearModalError() {
  const el = document.getElementById('modal-err');
  if(el) el.classList.remove('show');
}
document.getElementById('modal-save').addEventListener('click', () => { if(_modalSaveFn) _modalSaveFn(); });
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => { if(e.target===e.currentTarget) closeModal(); });

// CONFIRM
let _confirmFn = null;
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
document.getElementById('confirm-ok').addEventListener('click', () => { if(_confirmFn) _confirmFn(); closeConfirm(); });
document.getElementById('confirm-overlay').addEventListener('click', e => { if(e.target===e.currentTarget) closeConfirm(); });

// DATES
function saveDates() {
  const s = document.getElementById('start-date').value;
  const e = document.getElementById('end-date').value;
  if(!s||!e){ toast('Please set both start and end date.','warning'); return; }
  if(s>=e){ toast('End date must be after start date.','error'); return; }
  State.startDate = s; State.endDate = e;
  set(KEY.startDate, s); set(KEY.endDate, e);
  touchConfig(); toast('Teaching period saved.','success');
}

// SECTIONS CRUD
const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function sectionSlotRowHTML(slot, idx) {
  return `<div class="slot-row" id="slot-row-${idx}">
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
    <button class="btn btn-danger btn-icon btn-sm" style="margin-bottom:0;flex-shrink:0" onclick="removeSlotRow(${idx})">✕</button>
  </div>`;
}

let _slotCounter = 0;
function addSlotRow(slot) {
  const container = document.getElementById('slots-container');
  const idx = _slotCounter++;
  const div = document.createElement('div');
  div.innerHTML = sectionSlotRowHTML(slot, idx);
  container.appendChild(div.firstElementChild);
}
function removeSlotRow(idx) {
  const el = document.getElementById('slot-row-'+idx);
  if(el) el.remove();
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

function readSlots() {
  const rows = document.querySelectorAll('.slot-row');
  return Array.from(rows).map(row => ({
    weekday:  row.querySelector('.slot-weekday').value,
    fromTime: row.querySelector('.slot-from').value,
    toTime:   row.querySelector('.slot-to').value,
    duration: parseFloat(row.querySelector('.slot-dur').value)||2.5,
  }));
}

function openSectionModal(mode, idx) {
  const sec = (mode!=='add') ? State.sections[idx] : null;
  const title = mode==='edit' ? 'Edit Section' : mode==='dup' ? 'Duplicate Section' : 'Add Section';
  openModal(title, sectionModalBody(sec), () => saveSectionModal(mode, idx));
  const slots = sec ? sec.slots : [{weekday:'Saturday',fromTime:'09:00',toTime:'11:45',duration:2.5}];
  slots.forEach(s => addSlotRow(s));
}

function saveSectionModal(mode, editIdx) {
  clearModalError();
  const name = document.getElementById('sec-name').value.trim();
  if(!name){ showModalError('Section name is required.'); return; }
  const slots = readSlots();
  if(!slots.length){ showModalError('At least one slot is required.'); return; }
  const obj = {name, slots};
  const dup = State.sections.find((s,i) => s.name===name && (mode==='add'||mode==='dup'||i!==editIdx));
  if(dup){ showModalError(`Section "${name}" already exists.`); return; }
  if(mode==='edit') State.sections[editIdx] = obj;
  else State.sections.push(obj);
  saveSection(); renderSections();
  closeModal(); toast(`Section "${name}" saved.`,'success');
}

function deleteSection(idx) {
  const s = State.sections[idx];
  confirm2('Delete Section', `Delete section "${s.name}"? Mappings using this section will also be removed.`, () => {
    State.mappings = State.mappings.filter(m=>m.section!==s.name);
    saveMapping();
    State.sections.splice(idx,1); saveSection(); renderSections(); renderMappings();
    toast(`Section "${s.name}" deleted.`,'warning');
  });
}

function renderSections() {
  const el = document.getElementById('sections-list');
  if(!State.sections.length){
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗓</div><p>No sections added yet.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Name</th><th>Slots</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>${State.sections.map((s,i)=>`<tr>
      <td><span class="badge badge-gold">${s.name}</span></td>
      <td style="font-size:.8rem;color:var(--text2)">${s.slots.map(sl=>`<span class="badge badge-grey" style="margin:.1rem">${sl.weekday.slice(0,3)} ${sl.fromTime}</span>`).join(' ')}</td>
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick="openSectionModal('edit',${i})">✎</button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Duplicate" onclick="openSectionModal('dup',${i})">⎘</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete" onclick="deleteSection(${i})">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

document.getElementById('add-section-btn').addEventListener('click', ()=>openSectionModal('add',null));

// COURSES CRUD
function courseModalBody(c) {
  return `
    <div class="modal-error" id="modal-err"></div>
    <div class="form-row">
      <div class="form-group"><label>Course Code</label><input type="text" id="c-code" placeholder="e.g. P-201" value="${c?c.code:''}"/></div>
      <div class="form-group"><label>Short Title</label><input type="text" id="c-short" placeholder="e.g. OR" value="${c?c.shortTitle:''}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group" style="flex:2"><label>Course Title</label><input type="text" id="c-title" placeholder="e.g. Operations Research" value="${c?c.title:''}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Credit</label><input type="number" id="c-credit" min="0" step="0.5" value="${c?c.credit:2}"/></div>
      <div class="form-group"><label>Duration (hrs)</label><input type="number" id="c-duration" min="0" step="0.5" value="${c?c.duration:20}"/></div>
      <div class="form-group"><label>Required Slots</label><input type="number" id="c-slots" min="1" value="${c?c.requiredSlots:8}"/></div>
    </div>`;
}

function openCourseModal(mode, idx) {
  const c = (mode!=='add') ? State.courses[idx] : null;
  const title = mode==='edit'?'Edit Course':mode==='dup'?'Duplicate Course':'Add Course';
  openModal(title, courseModalBody(c), ()=>saveCourseModal(mode,idx));
}

function saveCourseModal(mode, editIdx) {
  clearModalError();
  const code  = document.getElementById('c-code').value.trim();
  const title = document.getElementById('c-title').value.trim();
  const short = document.getElementById('c-short').value.trim();
  const credit = parseFloat(document.getElementById('c-credit').value)||0;
  const dur    = parseFloat(document.getElementById('c-duration').value)||0;
  const slots  = parseInt(document.getElementById('c-slots').value)||0;
  if(!code||!title){ showModalError('Course code and title are required.'); return; }
  const obj = {code, title, shortTitle:short, credit, duration:dur, requiredSlots:slots};
  const dup = State.courses.find((c,i)=>c.code===code&&(mode==='add'||mode==='dup'||i!==editIdx));
  if(dup){ showModalError(`Course code "${code}" already exists.`); return; }
  if(mode==='edit') State.courses[editIdx]=obj;
  else State.courses.push(obj);
  saveCourse(); renderCourses();
  closeModal(); toast(`Course "${code}" saved.`,'success');
}

function deleteCourse(idx) {
  const c = State.courses[idx];
  confirm2('Delete Course', `Delete "${c.code}"? Mappings using this course will also be removed.`, ()=>{
    State.mappings = State.mappings.filter(m=>m.courseCode!==c.code);
    saveMapping();
    State.courses.splice(idx,1); saveCourse(); renderCourses(); renderMappings();
    toast(`Course "${c.code}" deleted.`,'warning');
  });
}

function renderCourses() {
  const el = document.getElementById('courses-list');
  if(!State.courses.length){
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📚</div><p>No courses added yet.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Code</th><th>Title</th><th>Short</th><th>Credit</th><th>Req Slots</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>${State.courses.map((c,i)=>`<tr>
      <td><span class="badge badge-blue" style="font-family:var(--font-m)">${c.code}</span></td>
      <td>${c.title}</td>
      <td><span class="badge badge-grey">${c.shortTitle||'—'}</span></td>
      <td>${c.credit}</td>
      <td><span class="badge badge-gold">${c.requiredSlots}</span></td>
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick="openCourseModal('edit',${i})">✎</button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Duplicate" onclick="openCourseModal('dup',${i})">⎘</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete" onclick="deleteCourse(${i})">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

document.getElementById('add-course-btn').addEventListener('click',()=>openCourseModal('add',null));

// COURSES CONFLICTS CRUD
function saveConflicts() { set(KEY.conflicts, State.courseConflicts); touchConfig(); }

function renderConflicts() {
  const el = document.getElementById('conflicts-list');
  if (!el) return;
  if (!State.courseConflicts.length) {
    el.innerHTML = `<div style="font-size:.82rem;color:var(--muted);padding:.4rem 0">No conflict groups defined.</div>`;
    return;
  }
  const cMap = Object.fromEntries(State.courses.map(c => [c.code, c]));
  el.innerHTML = State.courseConflicts.map((group, i) => {
    const allSections = State.sections.map(s => s.name);
    const isAllSections =
      group.sections.length === allSections.length &&
      group.sections.every(s => allSections.includes(s));

    return `
      <div class="slot-row" style="align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:.5rem">
        
        <span style="font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;flex-shrink:0">
          Group ${i+1}
        </span>

        <!-- COURSES -->
        <div style="display:flex;flex-wrap:wrap;gap:.35rem;flex:1">
          ${group.courses.map(code => {
            const c = cMap[code];
            return `<span class="badge badge-blue" style="font-family:var(--font-m)">
              ${c ? c.shortTitle || code : code}
            </span>`;
          }).join('')}
        </div>

        <!-- SECTIONS -->
        <div style="display:flex;flex-wrap:wrap;gap:.35rem;flex:1">
          ${
            isAllSections
              ? `<span class="badge badge-grey">All Sections</span>`
              : group.sections.map(sec => `
                  <span class="badge badge-grey">Sec ${sec}</span>
                `).join('')
          }
        </div>

        <button class="btn btn-ghost btn-icon btn-sm" title="Edit group" onclick="openConflictModal(${i})">✎</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete group" onclick="deleteConflictGroup(${i})">✕</button>
      </div>`;
  }).join('');
}

function conflictModalBody(groupIdx) {
  const group = groupIdx === null ? {courses:[], sections:[]} : (State.courseConflicts[groupIdx] || {courses:[], sections:[]});
  const courseSet = new Set(group.courses);
  const sectionSet = new Set(group.sections);

  if (!State.courses.length) return `<p>No courses defined yet.</p>`;

  return `
    <div class="modal-error" id="modal-err"></div>

    <p style="font-size:.82rem;color:var(--text2)">Select courses:</p>
    <div style="display:flex;flex-direction:column;gap:.3rem;margin-bottom:1rem">
      ${State.courses.map(c => `
        <label>
          <input type="checkbox" class="conflict-course-chk" value="${c.code}" ${courseSet.has(c.code)?'checked':''}>
          ${c.shortTitle || c.code} - ${c.title}
        </label>
      `).join('')}
    </div>

    <p style="font-size:.82rem;color:var(--text2)">Select sections:</p>
    <div style="display:flex;flex-direction:column;gap:.3rem">
      ${State.sections.map(s => `
        <label>
          <input type="checkbox" class="conflict-section-chk" value="${s.name}" ${sectionSet.has(s.name)?'checked':''}>
          Section ${s.name}
        </label>
      `).join('')}
    </div>
  `;
}

function openConflictModal(groupIdx) {
  const title = groupIdx === null ? 'Add Conflict Group' : 'Edit Conflict Group';
  openModal(title, conflictModalBody(groupIdx), () => saveConflictModal(groupIdx));
}

function saveConflictModal(groupIdx) {
  clearModalError();

  const selectedCourses = [...document.querySelectorAll('.conflict-course-chk:checked')].map(el => el.value);
  const selectedSections = [...document.querySelectorAll('.conflict-section-chk:checked')].map(el => el.value);

  if (selectedCourses.length < 2) {
    showModalError('Select at least 2 courses for a conflict group.');
    return;
  }
  if (selectedSections.length < 1) {
    showModalError('Select at least 1 section.');
    return;
  }

  const obj = {
    courses: selectedCourses,
    sections: selectedSections
  };

  if (groupIdx === null) State.courseConflicts.push(obj);
  else State.courseConflicts[groupIdx] = obj;

  saveConflicts();
  renderConflicts();
  closeModal();
  toast('Conflict group saved.', 'success');
}

function deleteConflictGroup(i) {
  confirm2('Delete Conflict Group', 'Remove this conflict group?', () => {
    State.courseConflicts.splice(i, 1);
    saveConflicts(); renderConflicts();
    toast('Conflict group removed.', 'warning');
  });
}

document.getElementById('add-conflict-btn').addEventListener('click', () => openConflictModal(null));

// FACULTY CRUD
let _dateCounter = 0;
function addDateRow(val='') {
  const c = document.getElementById('unavail-container');
  const idx = _dateCounter++;
  const div = document.createElement('div');
  div.id = 'date-row-'+idx;
  div.style.cssText = 'display:flex;gap:.5rem;margin-bottom:.4rem;align-items:center';
  div.innerHTML = `<input type="date" class="unavail-date" value="${val}" style="flex:1;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:.45rem .65rem;border-radius:var(--r);font-family:var(--font-u);font-size:.85rem"/>
    <button class="btn btn-danger btn-icon btn-sm" onclick="document.getElementById('date-row-${idx}').remove()">✕</button>`;
  c.appendChild(div);
}

function facultyModalBody(f) {
  _dateCounter = 0;
  return `
    <div class="modal-error" id="modal-err"></div>
    <div class="form-row">
      <div class="form-group" style="flex:2"><label>Full Name</label><input type="text" id="f-full" placeholder="e.g. Prof. Prashant N Reddy" value="${f?f.fullName:''}"/></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Short Name</label><input type="text" id="f-short" placeholder="e.g. Prof PNR" value="${f?f.shortName:''}"/></div>
      <div class="form-group"><label>Max Load / Day</label><input type="number" id="f-load" min="1" max="10" value="${f?f.maxLoadPerDay:2}"/></div>
    </div>
    <hr class="form-divider"/>
    <div class="slots-label">Unavailable Dates</div>
    <div id="unavail-container"></div>
    <button class="btn btn-ghost btn-sm" style="margin-top:.4rem" onclick="addDateRow('')">+ Add Date</button>`;
}

function openFacultyModal(mode, idx) {
  const f = (mode!=='add') ? State.faculty[idx] : null;
  const title = mode==='edit'?'Edit Faculty':'Add Faculty';
  openModal(title, facultyModalBody(f), ()=>saveFacultyModal(mode,idx));
  if(f) f.unavailableDates.forEach(d=>addDateRow(d));
}

function saveFacultyModal(mode, editIdx) {
  clearModalError();
  const full  = document.getElementById('f-full').value.trim();
  const short = document.getElementById('f-short').value.trim();
  const load  = parseInt(document.getElementById('f-load').value)||2;
  const dates = Array.from(document.querySelectorAll('.unavail-date'))
    .map(i=>i.value).filter(Boolean);
  if(!full||!short){ showModalError('Full name and short name are required.'); return; }
  const obj = {fullName:full, shortName:short, maxLoadPerDay:load, unavailableDates:dates};
  const dup = State.faculty.find((f,i)=>f.shortName===short&&(mode==='add'||i!==editIdx));
  if(dup){ showModalError(`Faculty short name "${short}" already exists.`); return; }
  if(mode==='edit') State.faculty[editIdx]=obj;
  else State.faculty.push(obj);
  saveFaculty(); renderFaculty();
  closeModal(); toast(`Faculty "${short}" saved.`,'success');
}

function deleteFaculty(idx) {
  const f = State.faculty[idx];
  confirm2('Delete Faculty',`Delete "${f.shortName}"? Mappings using this faculty will also be removed.`,()=>{
    State.mappings = State.mappings.filter(m=>m.facultyShortName!==f.shortName);
    saveMapping();
    State.faculty.splice(idx,1); saveFaculty(); renderFaculty(); renderMappings();
    toast(`Faculty "${f.shortName}" deleted.`,'warning');
  });
}

function renderFaculty() {
  const el = document.getElementById('faculty-list');
  if(!State.faculty.length){
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">👨‍🏫</div><p>No faculty added yet.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Full Name</th><th>Short Name</th><th>Max/Day</th><th>Unavailable Dates</th><th style="width:90px">Actions</th></tr></thead>
    <tbody>${State.faculty.map((f,i)=>`<tr>
      <td>${f.fullName}</td>
      <td><span class="badge badge-gold" style="font-family:var(--font-m)">${f.shortName}</span></td>
      <td style="text-align:center">${f.maxLoadPerDay}</td>
      <td style="font-size:.78rem;color:var(--text2)">${f.unavailableDates.length?f.unavailableDates.map(d=>`<span class="badge badge-grey" style="margin:.1rem">${d}</span>`).join(' '):'<span style="color:var(--muted)">None</span>'}</td>
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick="openFacultyModal('edit',${i})">✎</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete" onclick="deleteFaculty(${i})">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

document.getElementById('add-faculty-btn').addEventListener('click',()=>openFacultyModal('add',null));

// MAPPING CRUD
function mappingModalBody(m) {
  const secOpts  = State.sections.map(s=>`<option value="${s.name}"${m&&m.section===s.name?' selected':''}>${s.name}</option>`).join('');
  const cOpts    = State.courses.map(c=>`<option value="${c.code}"${m&&m.courseCode===c.code?' selected':''}>${c.code} - ${c.title}</option>`).join('');
  const fOpts    = State.faculty.map(f=>`<option value="${f.shortName}"${m&&m.facultyShortName===f.shortName?' selected':''}>${f.shortName}</option>`).join('');
  return `
    <div class="modal-error" id="modal-err"></div>
    <div class="form-row"><div class="form-group"><label>Section</label><select id="m-sec">${secOpts||'<option disabled>No sections</option>'}</select></div></div>
    <div class="form-row"><div class="form-group"><label>Course</label><select id="m-course">${cOpts||'<option disabled>No courses</option>'}</select></div></div>
    <div class="form-row"><div class="form-group"><label>Faculty</label><select id="m-fac">${fOpts||'<option disabled>No faculty</option>'}</select></div></div>`;
}

function openMappingModal(mode, idx) {
  const m = (mode!=='add') ? State.mappings[idx] : null;
  const title = mode==='edit'?'Edit Mapping':mode==='dup'?'Duplicate Mapping':'Add Mapping';
  if(!State.sections.length||!State.courses.length||!State.faculty.length){
    toast('Please add sections, courses, and faculty first.','warning'); return;
  }
  openModal(title, mappingModalBody(m), ()=>saveMappingModal(mode,idx));
}

function saveMappingModal(mode, editIdx) {
  clearModalError();
  const sec  = document.getElementById('m-sec').value;
  const code = document.getElementById('m-course').value;
  const fac  = document.getElementById('m-fac').value;
  if(!sec||!code||!fac){ showModalError('All fields are required.'); return; }
  const obj = {section:sec, courseCode:code, facultyShortName:fac};
  const dup = State.mappings.find((m,i)=>m.section===sec&&m.courseCode===code&&(mode==='add'||mode==='dup'||i!==editIdx));
  if(dup){ showModalError(`Mapping for section ${sec} / ${code} already exists.`); return; }
  if(mode==='edit') State.mappings[editIdx]=obj;
  else State.mappings.push(obj);
  saveMapping(); renderMappings();
  closeModal(); toast('Mapping saved.','success');
}

function deleteMapping(idx) {
  confirm2('Delete Mapping','Remove this section-course-faculty mapping?',()=>{
    State.mappings.splice(idx,1); saveMapping(); renderMappings();
    toast('Mapping removed.','warning');
  });
}

function renderMappings() {
  const el = document.getElementById('mapping-list');
  if(!State.mappings.length){
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔗</div><p>No mappings added yet.</p></div>`;
    return;
  }
  const cMap = Object.fromEntries(State.courses.map(c=>[c.code,c]));
  const fMap = Object.fromEntries(State.faculty.map(f=>[f.shortName,f]));
  el.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Section</th><th>Course</th><th>Faculty</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>${State.mappings.map((m,i)=>`<tr>
      <td><span class="badge badge-gold">${m.section}</span></td>
      <td><span class="badge badge-blue" style="font-family:var(--font-m);margin-right:.35rem">${m.courseCode}</span>${cMap[m.courseCode]?cMap[m.courseCode].title:m.courseCode}</td>
      <td>${fMap[m.facultyShortName]?fMap[m.facultyShortName].fullName:m.facultyShortName}</td>
      <td>
        <button class="btn btn-ghost btn-icon btn-sm" title="Edit" onclick="openMappingModal('edit',${i})">✎</button>
        <button class="btn btn-ghost btn-icon btn-sm" title="Duplicate" onclick="openMappingModal('dup',${i})">⎘</button>
        <button class="btn btn-danger btn-icon btn-sm" title="Delete" onclick="deleteMapping(${i})">✕</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

document.getElementById('add-mapping-btn').addEventListener('click',()=>openMappingModal('add',null));

// RESET
document.getElementById('reset-btn').addEventListener('click',()=>{
  confirm2('Reset All Data','This will permanently delete all sections, courses, faculty, mappings, and the generated timetable. This cannot be undone.',()=>{
    Object.values(KEY).forEach(k=>localStorage.removeItem(k));
    location.reload();
  });
});

// TIMETABLE GENERATION
const COURSE_PALETTE = ['#4f8ef7','#4caf7d','#c4953a','#9b6af5','#e07d3a','#e05252','#2aa3b8','#b84585'];
let _courseColorMap = {};

function getCourseColor(code) {
  if(!_courseColorMap[code]) {
    const idx = Object.keys(_courseColorMap).length % COURSE_PALETTE.length;
    _courseColorMap[code] = COURSE_PALETTE[idx];
  }
  return _courseColorMap[code];
}

function getConfigData() {
  return {
    startDate:  State.startDate,
    endDate:    State.endDate,
    sections:   State.sections,
    courses:    State.courses,
    faculty:    State.faculty,
    mappings:   State.mappings,
    courseConflicts: State.courseConflicts,
  };
}

function validateConfig() {
  const errs = [];
  if(!State.startDate||!State.endDate) errs.push('Teaching period (start/end date) not set.');
  if(!State.sections.length) errs.push('No sections defined.');
  if(!State.courses.length)  errs.push('No courses defined.');
  if(!State.faculty.length)  errs.push('No faculty defined.');
  if(!State.mappings.length) errs.push('No section-course-faculty mappings defined.');
  return errs;
}

async function generateTimetable() {
  const errs = validateConfig();
  if(errs.length){ toast(errs[0],'error'); return; }
  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  let elapsed = 0;
  const timer = setInterval(()=>{ elapsed++; btn.innerHTML=`<span class="spinner"></span> Solving… ${elapsed}s`; },1000);
  try {
    const res = await fetch('/api/solve',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(getConfigData()),
    });
    const data = await res.json();
    clearInterval(timer); btn.disabled=false; btn.innerHTML='⚡ Generate Timetable';
    if(data.status==='error'){
      toast('Error: '+data.message,'error'); return;
    }
    if(data.status==='infeasible'){
      toast('No feasible timetable found — even with soft constraints. Check your configuration (slots, required sessions, faculty availability, conflict groups).','error');
      return;
    }
    State.timetable = data.timetable;
    State.timetableMeta = {
      timestamp: data.timestamp,
      constraintType: data.constraint_type,
      penalty: data.penalty,
    };
    set(KEY.timetable, State.timetable);
    set(KEY.timetableMeta, State.timetableMeta);
    document.getElementById('verify-results').style.display='none';
    refreshTimetableTab();
    toast(`Timetable generated! Constraint: ${data.constraint_type}${data.penalty>0?' | Penalty: '+data.penalty:''}`, 'success');
  } catch(e) {
    clearInterval(timer); btn.disabled=false; btn.innerHTML='⚡ Generate Timetable';
    toast('Request failed. Is the server running?','error');
    console.error(e);
  }
}

function refreshTimetableTab() {
  const meta = State.timetableMeta;
  const tt   = State.timetable;
  const noTT = document.getElementById('tt-no-timetable');
  const metaCard = document.getElementById('tt-meta-card');
  const verifyBtn = document.getElementById('verify-btn');

  if(!tt||!tt.length){
    noTT.style.display='block'; metaCard.style.display='none';
    document.getElementById('tt-table-wrap').style.display='none';
    verifyBtn.style.display='none';
    return;
  }
  noTT.style.display='none'; metaCard.style.display='flex';
  verifyBtn.style.display='inline-flex';

  const ts = new Date(meta.timestamp);
  document.getElementById('tt-meta-time').textContent = ts.toLocaleString();
  document.getElementById('tt-meta-type').innerHTML = meta.constraintType==='hard'
    ? '<span class="badge badge-green">Hard (strict)</span>'
    : '<span class="badge badge-red">Soft (penalty)</span>';
  document.getElementById('tt-meta-penalty').textContent =
    meta.constraintType==='hard'?'0 (perfect)':meta.penalty+' violation'+(meta.penalty!==1?'s':'');
  document.getElementById('tt-meta-total').textContent = tt.length+' sessions';

  // stale check
  const configEdit = get(KEY.configEdit);
  const stale = configEdit && new Date(configEdit)>new Date(meta.timestamp);
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

function populateFilters(tt) {
  const allSections = [...new Set(tt.map(r => r.section))].sort();

  // Init filters on first call
  const rowFields = {
    date: [...new Set(tt.map(r => r.date))].sort(),
    day:  [...new Set(tt.map(r => r.day))],
    time: [...new Set(tt.map(r => r.timeLabel))].sort(),
  };
  Object.entries(rowFields).forEach(([key, vals]) => {
    if (ActiveFilters[key].size === 0) vals.forEach(v => ActiveFilters[key].add(v));
  });
  if (ActiveFilters.section.size === 0) allSections.forEach(s => ActiveFilters.section.add(s));

  // Build 2-row thead
  const visibleSections = allSections.filter(s => ActiveFilters.section.has(s));
  const sectionOptsHTML = allSections.map(s => `
    <label>
      <input type="checkbox" value="${s}" ${ActiveFilters.section.has(s) ? 'checked' : ''}
        onchange="toggleFilterValue('section', this)">
      ${s}
    </label>`).join('');

  document.getElementById('tt-thead').innerHTML = `
    <tr>
      ${filterThHTML('date', 'Date', 'tt-sticky-0')}
      ${filterThHTML('day',  'Day',  'tt-sticky-1')}
      ${filterThHTML('time', 'Time', 'tt-sticky-2')}
      <th colspan="${visibleSections.length}" style="text-align:center;padding:.5rem">
        <div class="filter" id="filter-section">
          <div class="filter-btn" onclick="toggleFilter('section')">Sections ⌄</div>
          <div class="filter-dropdown">
            <input type="text" placeholder="Search..." oninput="filterSearch('section', this.value)">
            <label><input type="checkbox" ${ActiveFilters.section.size === allSections.length ? 'checked' : ''} onchange="toggleAll('section', this)"> All</label>
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
  const allSections = [...new Set(tt.map(r => r.section))].sort();
  const sections = allSections.filter(s => !ActiveFilters.section.size || ActiveFilters.section.has(s));

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
    if (!tm.has(r.timeLabel)) tm.set(r.timeLabel, {});
    tm.get(r.timeLabel)[r.section] = r;
  });

  // 5. Remove time slots where ALL visible sections are empty
  for (const [dk, group] of dateGroups) {
    for (const [tl, sessMap] of group.times) {
      if (!sections.some(s => sessMap[s])) group.times.delete(tl);
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
        const r = sessMap[sec];
        if (!r) return `<td style="color:var(--muted);text-align:center;font-size:.8rem">—</td>`;
        const col = getCourseColor(r.courseCode);
        return `<td style="text-align:center">
          <span class="course-chip" style="background:${col}22;color:${col};border:1px solid ${col}44">${r.courseShort||r.courseCode}</span>
          <span style="color:var(--text2);font-size:.75rem;display:block;margin-top:.2rem">${r.facultyShort||r.faculty}</span>
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
  const stale = configEdit && new Date(configEdit)>new Date(meta.timestamp);
  const el = document.getElementById('tt-stale-warn');
  if(el) el.style.display = stale?'flex':'none';
}

// TIMETABLE VERIFICATION
async function verifyTimetable() {
  if(!State.timetable||!State.timetable.length){ toast('No timetable to verify.','warning'); return; }
  const btn = document.getElementById('verify-btn');
  btn.disabled=true; btn.innerHTML='<span class="spinner"></span> Verifying…';
  try {
    const res = await fetch('/api/verify',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({config:getConfigData(), timetable:State.timetable}),
    });
    const data = await res.json();
    btn.disabled=false; btn.innerHTML='✓ Verify Timetable';
    if(data.error){ toast('Verify error: '+data.error,'error'); return; }
    renderVerification(data);
    toast('Verification complete.', data.allClear?'success':'warning');
  } catch(e) {
    btn.disabled=false; btn.innerHTML='✓ Verify Timetable';
    toast('Request failed.','error'); console.error(e);
  }
}

function renderVerification(data) {
  const wrap = document.getElementById('verify-results');
  wrap.style.display = 'block';
  wrap.scrollIntoView({behavior:'smooth', block:'start'});

  // stat cards
  const totalSess = data.sessionCount.length;
  const okSess    = data.sessionCount.filter(r=>r.ok).length;
  const loadViol  = data.facultyLoad.filter(r=>!r.ok).length;
  const consec    = data.totalPenalty;
  const clone     = data.cloneViolations.length;
  const spacing   = data.spacingViolations.length;
  const unavail   = data.unavailViolations.length;

  document.getElementById('verify-stats').innerHTML = [
    {val:`${okSess}/${totalSess}`, label:'Session Counts OK', cls: okSess===totalSess?'ok':'fail'},
    {val:loadViol===0?'✓':loadViol, label:'Load Violations', cls:loadViol===0?'ok':'fail'},
    {val:clone===0?'✓':clone, label:'Cloning Violations', cls:clone===0?'ok':'fail'},
    {val:spacing===0?'✓':spacing, label:'Spacing Violations', cls:spacing===0?'ok':'fail'},
    {val:unavail===0?'✓':unavail, label:'Unavailability', cls:unavail===0?'ok':'fail'},
    {val:consec===0?'✓':consec, label:'Consec. Week Violations', cls:consec===0?'ok':consec<=3?'warn':'fail'},
  ].map(s=>`<div class="verify-stat ${s.cls}">
    <div class="vs-val">${s.val}</div>
    <div class="vs-label">${s.label}</div>
  </div>`).join('');

  let html = '';

  // 1. Session counts
  html += `<div class="verify-section">
    <div class="verify-section-title">${okSess===totalSess?'✅':'❌'} Session Count Verification</div>
    <div class="table-wrap" style="max-height:280px"><table class="data-table">
      <thead><tr><th>Section</th><th>Course</th><th>Required</th><th>Scheduled</th><th>Status</th></tr></thead>
      <tbody>${data.sessionCount.map(r=>`<tr>
        <td><span class="badge badge-gold">${r.section}</span></td>
        <td><span class="badge badge-blue" style="font-family:var(--font-m)">${r.course}</span></td>
        <td style="text-align:center">${r.required}</td>
        <td style="text-align:center">${r.scheduled}</td>
        <td style="text-align:center">${r.ok?'<span style="color:var(--green)">✓</span>':'<span style="color:var(--red)">✗</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;

  // 2. Faculty load
  const loadIssues = data.facultyLoad.filter(r=>!r.ok);
  html += `<div class="verify-section">
    <div class="verify-section-title">${loadIssues.length===0?'✅':'❌'} Faculty Daily Load</div>
    <div class="table-wrap" style="max-height:280px"><table class="data-table">
      <thead><tr><th>Faculty</th><th>Date</th><th>Sessions</th><th>Max Allowed</th><th>Status</th></tr></thead>
      <tbody>${data.facultyLoad.map(r=>`<tr>
        <td>${r.faculty}</td>
        <td style="font-family:var(--font-m);font-size:.8rem">${r.date}</td>
        <td style="text-align:center"><span class="badge ${r.ok?'badge-green':'badge-red'}">${r.sessions}</span></td>
        <td style="text-align:center">${r.maxAllowed}</td>
        <td style="text-align:center">${r.ok?'<span style="color:var(--green)">✓</span>':'<span style="color:var(--red)">✗</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;

  // 3. Consecutive week violations
  html += `<div class="verify-section">
    <div class="verify-section-title">${consec===0?'✅':'⚠'} Consecutive Week Violations (${consec} total)</div>`;
  if(consec>0) {
    html += `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Section</th><th>Course</th><th>Week</th><th>Week+1</th></tr></thead>
      <tbody>${data.consecutiveViolations.map(r=>`<tr>
        <td><span class="badge badge-gold">${r.section}</span></td>
        <td><span class="badge badge-blue" style="font-family:var(--font-m)">${r.course}</span></td>
        <td>Week ${r.week}</td><td>Week ${r.weekNext}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  } else {
    html += `<p style="font-size:.85rem;color:var(--green);padding:.4rem 0">No consecutive-week violations — alternate weekend rule perfectly satisfied.</p>`;
  }
  html += `</div>`;

  // 4. Other violations
  if(clone>0){
    html += `<div class="verify-section"><div class="verify-section-title">❌ Faculty Cloning Violations</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Faculty</th><th>Date</th><th>Time</th><th>Sections</th></tr></thead>
      <tbody>${data.cloneViolations.map(r=>`<tr><td>${r.faculty}</td><td>${r.date}</td><td>${r.time}</td><td>${r.sections.join(', ')}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  }
  if(spacing>0){
    html += `<div class="verify-section"><div class="verify-section-title">❌ Course Spacing Violations (same course twice in one day)</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Section</th><th>Course</th><th>Date</th><th>Count</th></tr></thead>
      <tbody>${data.spacingViolations.map(r=>`<tr><td>${r.section}</td><td>${r.course}</td><td>${r.date}</td><td>${r.count}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  }
  if(unavail>0){
    html += `<div class="verify-section"><div class="verify-section-title">❌ Unavailability Violations</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Faculty</th><th>Date</th><th>Section</th><th>Course</th></tr></thead>
      <tbody>${data.unavailViolations.map(r=>`<tr><td>${r.faculty}</td><td>${r.date}</td><td>${r.section}</td><td>${r.course}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
  }

  // 5. Week distribution heatmap
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
    btn.textContent='Section '+s;
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
  const {weeks, courses, data: mat} = dist;
  let t = `<div style="overflow-x:auto"><table class="heatmap-table">
    <thead><tr><th style="text-align:left;padding-right:1rem">Course \\ Week</th>${weeks.map(w=>`<th>W${w}</th>`).join('')}</tr></thead>
    <tbody>${courses.map((c,ci)=>`<tr>
      <td style="text-align:left;padding-right:1rem;color:var(--text2);white-space:nowrap">
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
    NOTE: Weeks are numbered relative to the calendar year, not the course start date.
  </p>
  `;
  container.innerHTML = t;
}

// INIT
function init() {
  loadState();
  // Restore date inputs
  if(State.startDate) document.getElementById('start-date').value = State.startDate;
  if(State.endDate)   document.getElementById('end-date').value   = State.endDate;
  renderSections();
  renderCourses();
  renderFaculty();
  renderMappings();
  renderConflicts();
  refreshTimetableTab();
}

init();

// EXPORT — Builds a styled .xlsx with one sheet per data type
function exportToExcel() {
  if (!State.sections.length && !State.courses.length && !State.faculty.length && !State.mappings.length) {
    toast('Nothing to export yet.', 'warning'); return;
  }
 
  const wb = XLSX.utils.book_new();
 
  // style helpers 
  // SheetJS CE doesn't support cell styles, but we can set col widths
  // and use a well-structured layout. Full styling requires SheetJS Pro,
  // so we use freeze panes + column widths which CE does support.
  function setColWidths(ws, widths) {
    ws['!cols'] = widths.map(w => ({ wch: w }));
  }
  function freezeHeader(ws) {
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  }
 
  // META sheet
  const metaRows = [
    ['Class Timetable Scheduler — Configuration Export'],
    ['Exported at', new Date().toLocaleString()],
    ['Teaching Start', State.startDate || ''],
    ['Teaching End',   State.endDate   || ''],
  ];
  const wsMeta = XLSX.utils.aoa_to_sheet(metaRows);
  setColWidths(wsMeta, [28, 30]);
  XLSX.utils.book_append_sheet(wb, wsMeta, 'Meta');
 
  // SECTIONS sheet 
  // Flatten: one row per slot (section repeated)
  const secHeader = ['Section Name', 'Weekday', 'From Time', 'To Time', 'Duration (hrs)'];
  const secRows   = [];
  State.sections.forEach(s =>
    s.slots.forEach(sl =>
      secRows.push([s.name, sl.weekday, sl.fromTime, sl.toTime, sl.duration])
    )
  );
  const wsSec = XLSX.utils.aoa_to_sheet([secHeader, ...secRows]);
  setColWidths(wsSec, [14, 12, 10, 10, 14]);
  freezeHeader(wsSec);
  XLSX.utils.book_append_sheet(wb, wsSec, 'Sections');
 
  // COURSES sheet 
  const cHeader = ['Course Code', 'Course Title', 'Short Title', 'Credit', 'Duration', 'Required Slots'];
  const cRows   = State.courses.map(c =>
    [c.code, c.title, c.shortTitle, c.credit, c.duration, c.requiredSlots]
  );
  const wsCourse = XLSX.utils.aoa_to_sheet([cHeader, ...cRows]);
  setColWidths(wsCourse, [14, 36, 12, 8, 10, 14]);
  freezeHeader(wsCourse);
  XLSX.utils.book_append_sheet(wb, wsCourse, 'Courses');
 
  // FACULTY sheet 
  // Flatten: one row per unavailable date (faculty repeated); if none, one row with empty date
  const fHeader = ['Full Name', 'Short Name', 'Max Load Per Day', 'Unavailable Dates (YYYY-MM-DD)'];
  const fRows   = [];
  State.faculty.forEach(f => {
    const dates = Array.isArray(f.unavailableDates)
      ? f.unavailableDates.join(', ')
      : '';
    fRows.push([f.fullName, f.shortName, f.maxLoadPerDay, dates]);
  });
  const wsFac = XLSX.utils.aoa_to_sheet([fHeader, ...fRows]);
  setColWidths(wsFac, [30, 16, 16, 24]);
  freezeHeader(wsFac);
  XLSX.utils.book_append_sheet(wb, wsFac, 'Faculty');
 
  // MAPPING sheet 
  const mHeader = ['Section', 'Course Code', 'Faculty Short Name'];
  const mRows   = State.mappings.map(m => [m.section, m.courseCode, m.facultyShortName]);
  const wsMap   = XLSX.utils.aoa_to_sheet([mHeader, ...mRows]);
  setColWidths(wsMap, [12, 16, 20]);
  freezeHeader(wsMap);
  XLSX.utils.book_append_sheet(wb, wsMap, 'Mapping');
 
  // CONFLICTS sheet
  if (State.courseConflicts.length) {
    const cfHeader = ['Group', 'Courses', 'Sections'];
    const cfRows   = [];

    State.courseConflicts.forEach((group, i) => {
      cfRows.push([
        i + 1,
        group.courses.join(', '),
        group.sections.join(', ')
      ]);
    });

    const wsCf = XLSX.utils.aoa_to_sheet([cfHeader, ...cfRows]);
    setColWidths(wsCf, [8, 30, 20]);
    freezeHeader(wsCf);
    XLSX.utils.book_append_sheet(wb, wsCf, 'Conflicts');
  }
 
  // TIMETABLE sheet (only if generated) 
  if (State.timetable && State.timetable.length) {
    const tt = State.timetable;

    // Collect unique sections in sorted order
    const ttSections = [...new Set(tt.map(r => r.section))].sort();

    // Pivot: group by date + day + fromTime + toTime
    const pivotMap = new Map();
    tt.forEach(r => {
      const key = `${r.date}||${r.day}||${r.fromTime}||${r.toTime}`;
      if (!pivotMap.has(key)) pivotMap.set(key, { date: r.date, day: r.day, fromTime: r.fromTime, toTime: r.toTime, cells: {} });
      pivotMap.get(key).cells[r.section] = `${r.courseShort || r.courseCode} (${r.facultyShort || ''})`;
    });

    // Sort pivot rows by date then fromTime
    const pivotRows = [...pivotMap.values()].sort((a, b) =>
      a.date.localeCompare(b.date) || a.fromTime.localeCompare(b.fromTime)
    );

    const ttHeader = ['Date', 'Day', 'From Time', 'To Time', ...ttSections];
    const ttRows   = pivotRows.map(p =>
      [p.date, p.day, p.fromTime, p.toTime, ...ttSections.map(s => p.cells[s] || '')]
    );

    const wsTT = XLSX.utils.aoa_to_sheet([ttHeader, ...ttRows]);
    setColWidths(wsTT, [12, 10, 10, 10, ...ttSections.map(() => 10)]);
    freezeHeader(wsTT);

    const meta = State.timetableMeta;
    if (meta) {
      // Append generation info two rows below the table
      const lastRow = ttRows.length + 3;
      XLSX.utils.sheet_add_aoa(wsTT, [
        [],
        ['__META__', 'Generated At', meta.timestamp],
        ['__META__', 'Constraint', meta.constraintType],
        ['__META__', 'Penalty', meta.penalty],
      ], { origin: { r: lastRow, c: 0 } });
    }
    XLSX.utils.book_append_sheet(wb, wsTT, 'Timetable');
  }
 
  // Download
  const date  = new Date().toISOString().slice(0, 10);
  const fname = `Program_Timetable_Config_${date}.xlsx`;
  XLSX.writeFile(wb, fname);
  toast(`Exported → ${fname}`, 'success');
}
 
// IMPORT — Reads .xlsx, parses each sheet, stores to localStorage
function importFromExcel(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'array' });
 
      // helper: sheet → array of row-objects 
      function sheetRows(sheetName) {
        if (!wb.SheetNames.includes(sheetName)) return [];
        return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
      }
 
      // META
      const metaSheet = wb.Sheets['Meta'];
      if (metaSheet) {
        const metaArr = XLSX.utils.sheet_to_json(metaSheet, { header: 1, defval: '' });
        // Row index 2 → Teaching Start, 3 → Teaching End
        const startVal = metaArr[2] && metaArr[2][1] ? String(metaArr[2][1]).trim() : '';
        const endVal   = metaArr[3] && metaArr[3][1] ? String(metaArr[3][1]).trim() : '';
        if (startVal) { State.startDate = startVal; set(KEY.startDate, startVal); }
        if (endVal)   { State.endDate   = endVal;   set(KEY.endDate,   endVal);   }
      }
 
      // SECTIONS 
      const secRows = sheetRows('Sections');
      if (secRows.length) {
        const secMap = {};
        secRows.forEach(r => {
          const name = String(r['Section Name'] || '').trim();
          if (!name) return;
          if (!secMap[name]) secMap[name] = { name, slots: [] };
          secMap[name].slots.push({
            weekday:  String(r['Weekday']        || 'Saturday').trim(),
            fromTime: String(r['From Time']      || '09:00').trim(),
            toTime:   String(r['To Time']        || '11:45').trim(),
            duration: parseFloat(r['Duration (hrs)']) || 2.5,
          });
        });
        State.sections = Object.values(secMap);
        set(KEY.sections, State.sections);
      }
 
      // COURSES
      const cRows = sheetRows('Courses');
      if (cRows.length) {
        State.courses = cRows
          .filter(r => r['Course Code'])
          .map(r => ({
            code:          String(r['Course Code']   || '').trim(),
            title:         String(r['Course Title']  || '').trim(),
            shortTitle:    String(r['Short Title']   || '').trim(),
            credit:        parseFloat(r['Credit'])          || 0,
            duration:      parseFloat(r['Duration'])        || 0,
            requiredSlots: parseInt(r['Required Slots'])    || 0,
          }));
        set(KEY.courses, State.courses);
      }
 
      // FACULTY
      const fRows = sheetRows('Faculty');
      if (fRows.length) {
        const facMap = {};
        fRows.forEach(r => {
          const short = String(r['Short Name'] || '').trim();
          if (!short) return;

          const datesStr = String(r['Unavailable Dates (YYYY-MM-DD)'] || '').trim();
          let dates = [];

          if (datesStr) {
            dates = datesStr
              .split(',')
              .map(d => d.trim())
              .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
          }

          facMap[short] = {
            fullName: String(r['Full Name'] || '').trim(),
            shortName: short,
            maxLoadPerDay: parseInt(r['Max Load Per Day']) || 2,
            unavailableDates: dates
          };
        });
        State.faculty = Object.values(facMap);
        set(KEY.faculty, State.faculty);
      }
 
      // MAPPING
      const mRows = sheetRows('Mapping');
      if (mRows.length) {
        State.mappings = mRows
          .filter(r => r['Section'] && r['Course Code'] && r['Faculty Short Name'])
          .map(r => ({
            section:          String(r['Section']             || '').trim(),
            courseCode:       String(r['Course Code']         || '').trim(),
            facultyShortName: String(r['Faculty Short Name']  || '').trim(),
          }));
        set(KEY.mappings, State.mappings);
      }

      // CONFLICTS
      const cfRows = sheetRows('Conflicts');
      if (cfRows.length) {
        const parsedGroups = [];

        cfRows.forEach(r => {
          const coursesStr  = String(r['Courses']  || '').trim();
          const sectionsStr = String(r['Sections'] || '').trim();

          if (!coursesStr || !sectionsStr) return;

          const courses = coursesStr
            .split(',')
            .map(c => c.trim())
            .filter(Boolean);

          const sections = sectionsStr
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

          if (courses.length >= 1 && sections.length >= 1) {
            parsedGroups.push({ courses, sections });
          }
        });

        State.courseConflicts = parsedGroups;
        set(KEY.conflicts, State.courseConflicts);
      }
 
      // TIMETABLE (optional, read-only — just restore display)
      const ttRows = sheetRows('Timetable');
      if (ttRows.length) {
        const timetable = [];
        const meta = {};

        // Build lookup maps from already-parsed config (shortTitle → course, shortName → faculty)
        const courseByShort = Object.fromEntries(
          (State.courses || []).map(c => [c.shortTitle, c])
        );
        const courseByCode  = Object.fromEntries(
          (State.courses || []).map(c => [c.code, c])
        );
        const facultyByShort = Object.fromEntries(
          (State.faculty || []).map(f => [f.shortName, f])
        );

        // Fixed columns; anything beyond is a section column
        const fixedCols = new Set(['Date', 'Day', 'From Time', 'To Time']);

        ttRows.forEach(r => {
          // Detect metadata sentinel rows
          if (String(r['Date'] || '').trim() === '__META__') {
            const key = String(r['Day'] || '').trim();
            const val = String(r['From Time'] || '').trim();
            if (key === 'Generated At') meta.timestamp = val;
            if (key === 'Constraint')   meta.constraintType = val;
            if (key === 'Penalty')      meta.penalty = val;
            return;
          }

          if (!r['Date']) return;

          const date      = String(r['Date']      || '').trim();
          const day       = String(r['Day']       || '').trim();
          const fromTime  = String(r['From Time'] || '').trim();
          const toTime    = String(r['To Time']   || '').trim();
          const timeLabel = `${fromTime} - ${toTime}`;

          // Each non-fixed column is a section
          Object.keys(r).forEach(col => {
            if (fixedCols.has(col)) return;
            const cellVal = String(r[col] || '').trim();
            if (!cellVal) return;

            const section = col.trim();

            // Parse "SHORTNAME (FACULTYSHORT)" — faculty short may contain spaces
            const match = cellVal.match(/^(.+?)\s*\((.+)\)$/);
            const rawShort  = match ? match[1].trim() : cellVal;
            const facShort  = match ? match[2].trim() : '';

            // Resolve course
            const course     = courseByShort[rawShort] || courseByCode[rawShort] || null;
            const courseCode  = course ? course.code       : rawShort;
            const courseTitle = course ? course.title      : rawShort;
            const courseShort = course ? course.shortTitle : rawShort;

            // Resolve faculty
            const facObj  = facultyByShort[facShort] || null;
            const faculty = facObj ? facObj.fullName : facShort;

            timetable.push({ date, day, fromTime, toTime, timeLabel, section, courseCode, courseTitle, courseShort, facultyShort: facShort, faculty });
          });
        });

        State.timetable = timetable;
        set(KEY.timetable, State.timetable);

        State.timetableMeta = Object.keys(meta).length ? meta : {
          timestamp: new Date().toISOString(),
          constraintType: 'imported',
          penalty: '?'
        };
        set(KEY.timetableMeta, State.timetableMeta);
      }
 
      // Re-render everything
      touchConfig();
      if (State.startDate) document.getElementById('start-date').value = State.startDate;
      if (State.endDate)   document.getElementById('end-date').value   = State.endDate;
      renderSections();
      renderCourses();
      renderFaculty();
      renderMappings();
      renderConflicts();
      refreshTimetableTab();
 
      const counts = [
        State.sections.length  + ' sections',
        State.courses.length   + ' courses',
        State.faculty.length   + ' faculty',
        State.mappings.length  + ' mappings',
        State.courseConflicts.length + ' conflict groups',
        State.timetable && State.timetable.length ? State.timetable.length + ' timetable sessions' : null,
      ].filter(Boolean).join(', ');
      toast(`Imported: ${counts}`, 'success');
 
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

// WIRE UP BUTTONS
document.getElementById('export-btn').addEventListener('click', exportToExcel);
 
document.getElementById('import-btn').addEventListener('click', () => {
  // Warn if data already exists
  const hasData = State.sections.length || State.courses.length || State.faculty.length || State.mappings.length;
  if (hasData) {
    confirm2(
      'Import & Overwrite',
      'Importing will replace all current sections, courses, faculty, mappings, and timetable data. Continue?',
      () => document.getElementById('import-file-input').click()
    );
  } else {
    document.getElementById('import-file-input').click();
  }
});
 
document.getElementById('import-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) {
    importFromExcel(file);
    e.target.value = ''; // reset so same file can be re-imported
  }
});
