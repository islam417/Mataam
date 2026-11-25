'use strict';

/* =========================================================
   المطعم المدرسي — تسجيل الوجبات ببطاقات QR / باركود
   كل البيانات محفوظة محليًا في IndexedDB (بدون إنترنت)
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const dateStr = (d = new Date()) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const timeStr = (d = new Date()) => pad(d.getHours()) + ':' + pad(d.getMinutes());
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase()
  .replace(/[ً-ْـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/\s+/g, ' ').trim();
const normCode = c => String(c || '').trim().toUpperCase().replace(/\s+/g, '');
const byClassName = (a, b) =>
  (a.cls || '').localeCompare(b.cls || '', 'ar', { numeric: true }) || (a.name || '').localeCompare(b.name || '', 'ar');

/* ---------------- قاعدة البيانات ---------------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('canteen-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('students', { keyPath: 'code' });
      const s = d.createObjectStore('scans', { keyPath: 'key' });
      s.createIndex('date', 'date');
      d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const st_ = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
const dbAll = name => req(st_(name).getAll());
const dbGet = (name, k) => req(st_(name).get(k));
const dbPut = (name, v) => req(st_(name, 'readwrite').put(v));
const dbDel = (name, k) => req(st_(name, 'readwrite').delete(k));
const dbClear = name => req(st_(name, 'readwrite').clear());
const scansByDate = d => req(st_('scans').index('date').getAll(d));
const scansRange = (a, b) => req(st_('scans').index('date').getAll(IDBKeyRange.bound(a, b)));
function bulkPut(name, items) {
  return new Promise((res, rej) => {
    const t = db.transaction(name, 'readwrite');
    const s = t.objectStore(name);
    items.forEach(i => s.put(i));
    t.oncomplete = () => res();
    t.onerror = t.onabort = () => rej(t.error);
  });
}

/* ---------------- الحالة ---------------- */
let students = new Map();           // code -> student
let settings = { school: '', sound: true, lastBackup: 0 };
let curDate = dateStr();

async function loadStudents() {
  students = new Map((await dbAll('students')).map(s => [s.code, s]));
  fillClassSelects();
}
async function loadSettings() {
  const m = await dbGet('meta', 'settings');
  if (m) settings = { ...settings, ...m.v };
}
const saveSettings = () => dbPut('meta', { k: 'settings', v: settings });

/* ---------------- واجهة عامة ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
const openDlg = d => (d.showModal ? d.showModal() : d.setAttribute('open', ''));
const closeDlg = d => (d.close ? d.close() : d.removeAttribute('open'));

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ar-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function updateHeader() {
  $('#todayBadge').textContent = fmtDate(dateStr());
  $('#appTitle').textContent = '🍽️ ' + (settings.school || 'المطعم المدرسي');
}

function classList() {
  return [...new Set([...students.values()].map(s => s.cls).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ar', { numeric: true }));
}
function fillClassSelects() {
  const list = classList();
  for (const id of ['#stClass', '#cdClass']) {
    const sel = $(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">كل الأقسام</option>' + list.map(c => `<option>${esc(c)}</option>`).join('');
    if (list.includes(cur)) sel.value = cur;
  }
}

/* ---------------- الصوت والاهتزاز ---------------- */
let audioCtx;
function beep(kind) {
  try { navigator.vibrate && navigator.vibrate(kind === 'ok' ? 60 : [120, 60, 120]); } catch (e) { }
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const seq = kind === 'ok' ? [[880, .1], [1175, .14]] : kind === 'dup' ? [[520, .12], [520, .12]] : [[200, .4]];
    let t = audioCtx.currentTime;
    for (const [f, d] of seq) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = kind === 'err' ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(.18, t);
      g.gain.exponentialRampToValueAtTime(.001, t + d);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + d);
      t += d + .04;
    }
  } catch (e) { }
}

/* ---------------- تسجيل وجبة ---------------- */
async function recordMeal(rawCode, via) {
  const code = normCode(rawCode);
  const st = students.get(code);
  if (!st) return { status: 'unknown', code };
  if (st.active === false) return { status: 'inactive', st };
  const date = dateStr();
  const key = date + '|' + code;
  const ex = await dbGet('scans', key);
  if (ex) return { status: 'dup', st, scan: ex };
  const scan = { key, date, code, ts: Date.now(), time: timeStr(), name: st.name, cls: st.cls || '', via: via || '' };
  await dbPut('scans', scan);
  return { status: 'ok', st, scan };
}

const ICONS = { ok: '✅', dup: '⚠️', err: '❌', idle: '🍽️' };
function showResult(kind, title, sub) {
  const r = $('#result');
  r.className = 'result ' + kind;
  r.innerHTML = `<div class="r-icon">${ICONS[kind]}</div><div class="r-name">${esc(title)}</div><div class="r-sub">${esc(sub)}</div>`;
}

async function handleScan(rawCode, via) {
  if (dateStr() !== curDate) { curDate = dateStr(); updateHeader(); }
  const r = await recordMeal(rawCode, via);
  if (r.status === 'ok') {
    showResult('ok', r.st.name, [r.st.cls, 'تم تسجيل وجبة الغداء'].filter(Boolean).join(' • '));
    beep('ok');
  } else if (r.status === 'dup') {
    showResult('dup', r.st.name, `استلم وجبته اليوم عند الساعة ${r.scan.time}`);
    beep('dup');
  } else if (r.status === 'inactive') {
    showResult('err', r.st.name, 'غير مسجّل في المطعم المدرسي');
    beep('err');
  } else {
    showResult('err', 'بطاقة غير معروفة', 'الرمز: ' + r.code);
    beep('err');
  }
  await refreshToday();
  return r;
}

async function refreshToday() {
  const list = (await scansByDate(dateStr())).sort((a, b) => b.ts - a.ts);
  $('#cntToday').textContent = list.length;
  const ul = $('#recent');
  ul.innerHTML = list.length
    ? list.slice(0, 12).map(s => `
      <li>
        <div class="main"><div class="nm">${esc(s.name)}</div><div class="meta">${esc(s.cls)}</div></div>
        <span class="time">${esc(s.time)}</span>
        <button class="btn sm" data-undo="${esc(s.key)}" type="button" aria-label="إلغاء التسجيل">✕</button>
      </li>`).join('')
    : '<li class="empty">لا توجد تسجيلات اليوم بعد</li>';
  if (!students.size) {
    showIdleHint();
  }
}
function showIdleHint() {
  const r = $('#result');
  if (!r.classList.contains('idle')) return;
  r.querySelector('.r-sub').textContent = students.size
    ? 'امسح بطاقة التلميذ بالكاميرا أو بقارئ الباركود'
    : 'لا يوجد تلاميذ بعد — ابدأ من تبويب «التلاميذ» ثم «البطاقات»';
}

$('#recent').addEventListener('click', async e => {
  const b = e.target.closest('[data-undo]');
  if (!b) return;
  const key = b.dataset.undo;
  const s = await dbGet('scans', key);
  if (!s || !confirm(`إلغاء تسجيل وجبة «${s.name}» اليوم؟`)) return;
  await dbDel('scans', key);
  toast('تم الإلغاء');
  refreshToday();
});

/* ---------------- مسح: إدخال يدوي / قارئ USB ---------------- */
const manual = $('#manual');
manual.addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = manual.value;
  manual.value = '';
  if (normCode(v)) await handleScan(v, 'kbd');
});

// قارئ الباركود يكتب كلوحة مفاتيح: نعيد التركيز تلقائيًا على الحقل
document.addEventListener('keydown', e => {
  if ($('#tab-scan').hidden) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1 || e.key === 'Enter') manual.focus();
});

$('#nameSearch').addEventListener('input', renderNameResults);
function renderNameResults() {
  const q = norm($('#nameSearch').value);
  const box = $('#nameResults');
  if (q.length < 2) { box.innerHTML = ''; return; }
  const arr = [...students.values()].filter(s => s.active !== false && norm(s.name).includes(q)).sort(byClassName).slice(0, 8);
  box.innerHTML = arr.length
    ? arr.map(s => `
      <div class="item">
        <div class="main"><div class="nm">${esc(s.name)}</div><div class="meta">${esc(s.cls)}</div></div>
        <button class="btn sm primary" data-code="${esc(s.code)}" type="button">تسجيل وجبة</button>
      </div>`).join('')
    : '<div class="empty">لا نتائج</div>';
}
$('#nameResults').addEventListener('click', async e => {
  const b = e.target.closest('[data-code]');
  if (!b) return;
  await handleScan(b.dataset.code, 'name');
  $('#nameSearch').value = '';
  $('#nameResults').innerHTML = '';
});

/* ---------------- مسح: الكاميرا ---------------- */
const video = $('#video'), cv = $('#cv'), cctx = cv.getContext('2d', { willReadFrequently: true });
let stream = null, scanning = false, detector = null, lastCode = '', lastAt = 0;

async function initDetector() {
  if (!('BarcodeDetector' in window)) return;
  try {
    const sup = await BarcodeDetector.getSupportedFormats();
    const want = ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'itf', 'codabar', 'upc_a', 'upc_e'];
    const f = want.filter(x => sup.includes(x));
    if (f.length) detector = new BarcodeDetector({ formats: f });
  } catch (e) { detector = null; }
}

async function startCamera() {
  if (stream) return;
  const err = $('#camErr');
  err.hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = 'الكاميرا غير متاحة. يجب فتح التطبيق عبر رابط آمن (https) أو استعمل قارئ الباركود.';
    err.hidden = false;
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    $('#camBox').hidden = false;
    $('#btnCam').textContent = '⏹ إيقاف الكاميرا';
    try { localStorage.setItem('camOn', '1'); } catch (e) { }
    scanning = true;
    scanLoop();
  } catch (e) {
    stream = null;
    err.textContent = e && e.name === 'NotAllowedError'
      ? 'تم رفض إذن الكاميرا. اسمح بالوصول للكاميرا من إعدادات المتصفح ثم أعد المحاولة.'
      : 'تعذّر تشغيل الكاميرا: ' + (e && e.message ? e.message : e);
    err.hidden = false;
  }
}
function stopCamera(forget) {
  scanning = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.srcObject = null;
  $('#camBox').hidden = true;
  $('#btnCam').textContent = '📷 تشغيل الكاميرا';
  if (forget) { try { localStorage.removeItem('camOn'); } catch (e) { } }
}
$('#btnCam').addEventListener('click', () => (stream ? stopCamera(true) : startCamera()));

async function scanLoop() {
  if (!scanning) return;
  try {
    if (video.readyState >= 2 && video.videoWidth) {
      let code = null;
      if (detector) {
        try {
          const r = await detector.detect(video);
          if (r.length) code = r[0].rawValue;
        } catch (e) { detector = null; }
      }
      if (!detector && !code && window.jsQR) {
        const w = video.videoWidth, h = video.videoHeight, sc = Math.min(1, 640 / w);
        cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
        cctx.drawImage(video, 0, 0, cv.width, cv.height);
        const img = cctx.getImageData(0, 0, cv.width, cv.height);
        const q = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (q) code = q.data;
      }
      if (code) await onCode(code);
    }
  } catch (e) { /* نتجاهل أخطاء الإطار الواحد */ }
  setTimeout(scanLoop, 140);
}
async function onCode(raw) {
  const code = normCode(raw);
  if (!code) return;
  const now = Date.now();
  const same = code === lastCode && now - lastAt < 3000;
  lastCode = code; lastAt = now;
  if (same) return;                 // نفس البطاقة ما تزال أمام الكاميرا
  await handleScan(code, 'cam');
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera(false);
  else if (!$('#tab-scan').hidden && localStorage.getItem('camOn') === '1') startCamera();
});

/* ---------------- التنقل ---------------- */
function showTab(id) {
  $$('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + id; });
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  window.scrollTo(0, 0);
  if (id === 'scan') {
    refreshToday(); showIdleHint(); renderBackupWarn();
    let cam = false; try { cam = localStorage.getItem('camOn') === '1'; } catch (e) { }
    if (cam) startCamera(); else if (!matchMedia('(pointer:coarse)').matches) manual.focus();
  } else {
    stopCamera(false);
  }
  if (id === 'students') renderStudents();
  if (id === 'cards') renderCards();
  if (id === 'reports') { renderReport(); renderMonth(); }
  if (id === 'settings') renderSettings();
}
$$('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------------- التلاميذ ---------------- */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(used = students) {
  for (let n = 0; n < 1000; n++) {
    let c = '';
    const buf = new Uint8Array(6);
    (crypto || window.crypto).getRandomValues(buf);
    for (const b of buf) c += CODE_CHARS[b % CODE_CHARS.length];
    if (!(used instanceof Set ? used.has(c) : used.has(c))) return c;
  }
  throw new Error('تعذّر توليد رمز');
}

function renderStudents() {
  const q = norm($('#stSearch').value), c = $('#stClass').value;
  const arr = [...students.values()]
    .filter(s => (!c || s.cls === c) && (!q || norm(s.name).includes(q) || s.code.toLowerCase().includes(q.replace(/\s/g, ''))))
    .sort(byClassName);
  $('#stCount').textContent = arr.length + ' / ' + students.size;
  $('#stList').innerHTML = arr.length ? arr.map(s => `
    <li>
      <div class="main">
        <div class="nm">${esc(s.name)}</div>
        <div class="meta">${esc(s.cls) || '—'} • <span dir="ltr">${esc(s.code)}</span>
          ${s.active === false ? '<span class="tag off">خارج المطعم</span>' : ''}</div>
      </div>
      <button class="btn sm" data-act="card" data-code="${esc(s.code)}" type="button" title="بطاقته">🪪</button>
      <button class="btn sm" data-act="edit" data-code="${esc(s.code)}" type="button" title="تعديل">✏️</button>
      <button class="btn sm" data-act="del" data-code="${esc(s.code)}" type="button" title="حذف">🗑️</button>
    </li>`).join('') : `<li class="empty">${students.size ? 'لا نتائج' : 'لا يوجد تلاميذ بعد. أضف تلميذًا أو استورد قائمة كاملة.'}</li>`;
}
$('#stSearch').addEventListener('input', renderStudents);
$('#stClass').addEventListener('change', renderStudents);

$('#stList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const s = students.get(b.dataset.code);
  if (!s) return;
  if (b.dataset.act === 'edit') openStudentForm(s);
  if (b.dataset.act === 'card') {
    showTab('cards');
    $('#cdClass').value = '';
    $('#cdSearch').value = s.name;
    renderCards();
  }
  if (b.dataset.act === 'del') {
    if (!confirm(`حذف «${s.name}»؟\nتبقى تسجيلاته السابقة ظاهرة في التقارير.`)) return;
    await dbDel('students', s.code);
    await loadStudents();
    renderStudents();
    toast('تم الحذف');
  }
});

let editing = null;
function openStudentForm(s) {
  editing = s ? s.code : null;
  $('#stFormTitle').textContent = s ? 'تعديل تلميذ' : 'إضافة تلميذ';
  $('#sfName').value = s ? s.name : '';
  $('#sfCls').value = s ? (s.cls || '') : ($('#stClass').value || '');
  $('#sfCode').value = s ? s.code : '';
  $('#sfCode').readOnly = !!s;
  $('#sfActive').checked = s ? s.active !== false : true;
  openDlg($('#dlgStudent'));
  setTimeout(() => $('#sfName').focus(), 50);
}
$('#btnAddStudent').addEventListener('click', () => openStudentForm(null));
$('#sfCancel').addEventListener('click', () => closeDlg($('#dlgStudent')));
$('#stForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#sfName').value.trim().replace(/\s+/g, ' ');
  const cls = $('#sfCls').value.trim();
  if (!name) { toast('أدخل الاسم'); return; }
  let code = normCode($('#sfCode').value);
  if (!editing) {
    if (code && students.has(code)) { toast('هذا الرمز مستعمل لتلميذ آخر'); return; }
    if (!code) code = genCode();
  } else code = editing;
  const old = students.get(code);
  await dbPut('students', { ...(old || { created: Date.now() }), code, name, cls, active: $('#sfActive').checked });
  closeDlg($('#dlgStudent'));
  await loadStudents();
  renderStudents();
  toast(editing ? 'تم الحفظ' : 'تمت الإضافة');
});

/* استيراد */
function parseImport(text) {
  text = String(text || '').replace(/^﻿/, '').trim();
  if (!text) return [];
  const delim = text.includes('\t') ? '\t' : (text.includes(';') ? ';' : ',');
  const rows = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => l.split(delim).map(c => c.trim().replace(/^"(.*)"$/, '$1').trim()));
  if (rows.length && /^(الاسم|اللقب|اسم|name|nom)/i.test(rows[0][0])) rows.shift();
  return rows.filter(r => r[0]).map(r => ({ name: r[0].replace(/\s+/g, ' '), cls: r[1] || '', code: normCode(r[2] || '') }));
}
$('#btnImport').addEventListener('click', () => {
  $('#imText').value = ''; $('#imInfo').textContent = ''; $('#imFile').value = '';
  openDlg($('#dlgImport'));
});
$('#imCancel').addEventListener('click', () => closeDlg($('#dlgImport')));
$('#imFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  $('#imText').value = await f.text();
  $('#imInfo').textContent = parseImport($('#imText').value).length + ' سطر جاهز للاستيراد';
});
$('#imText').addEventListener('input', () => {
  const n = parseImport($('#imText').value).length;
  $('#imInfo').textContent = n ? n + ' سطر جاهز للاستيراد' : '';
});
$('#imGo').addEventListener('click', async () => {
  const rows = parseImport($('#imText').value);
  if (!rows.length) { $('#imInfo').textContent = 'لا توجد بيانات للاستيراد'; return; }
  const used = new Set(students.keys());
  const byKey = new Map([...students.values()].map(s => [norm(s.name) + '|' + norm(s.cls), s]));
  const put = [];
  let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    if (r.code && students.has(r.code)) {
      const o = students.get(r.code);
      put.push({ ...o, name: r.name, cls: r.cls || o.cls });
      updated++; continue;
    }
    const k = norm(r.name) + '|' + norm(r.cls);
    if (!r.code && byKey.has(k)) { skipped++; continue; }
    const code = r.code || genCode(used);
    const s = { code, name: r.name, cls: r.cls, active: true, created: Date.now() };
    used.add(code); byKey.set(k, s); put.push(s); added++;
  }
  await bulkPut('students', put);
  await loadStudents();
  closeDlg($('#dlgImport'));
  renderStudents();
  toast(`أُضيف ${added} • حُدّث ${updated}` + (skipped ? ` • تُجوهل ${skipped} مكرر` : ''));
});

/* ---------------- البطاقات ---------------- */
function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}
function renderCards() {
  const c = $('#cdClass').value, q = norm($('#cdSearch').value);
  const arr = [...students.values()].filter(s => (!c || s.cls === c) && (!q || norm(s.name).includes(q))).sort(byClassName);
  $('#cdCount').textContent = arr.length;
  const school = settings.school || 'المطعم المدرسي';
  const area = $('#cardsArea');
  if (!arr.length) {
    area.innerHTML = '<div class="empty">لا توجد بطاقات. أضف التلاميذ أولاً.</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < arr.length; i += 10) {
    html += '<div class="sheet">' + arr.slice(i, i + 10).map(s => `
      <div class="card">
        <div class="info">
          <div class="school">${esc(school)} — بطاقة المطعم</div>
          <div class="nm${s.name.length > 22 ? ' long' : ''}">${esc(s.name)}</div>
          <div class="cl">${esc(s.cls)}</div>
        </div>
        <div class="qr">${qrSvg(s.code)}<div class="cd">${esc(s.code)}</div></div>
      </div>`).join('') + '</div>';
  }
  area.innerHTML = html;
}
$('#cdClass').addEventListener('change', renderCards);
$('#cdSearch').addEventListener('input', renderCards);

// الطباعة تعتمد على التبويب الظاهر فقط (لا حالة مؤقتة)، لتعمل أيضًا على متصفح الهاتف
$('#btnPrintCards').addEventListener('click', () => window.print());
$('#btnPrintRep').addEventListener('click', () => window.print());

/* ---------------- التقارير ---------------- */
function csvCell(v) { return '"' + String(v ?? '').replace(/"/g, '""') + '"'; }
function downloadFile(name, text, mime) {
  const blob = new Blob(['﻿' + text], { type: mime || 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const toCSV = rows => rows.map(r => r.map(csvCell).join(';')).join('\r\n');

async function dayData(d) {
  const scans = (await scansByDate(d)).sort((a, b) => a.ts - b.ts);
  const active = [...students.values()].filter(s => s.active !== false);
  const ate = new Set(scans.map(s => s.code));
  const absent = active.filter(s => !ate.has(s.code)).sort(byClassName);
  const cls = new Map();
  active.forEach(s => {
    const k = s.cls || '—';
    const o = cls.get(k) || { ate: 0, total: 0 };
    o.total++; if (ate.has(s.code)) o.ate++;
    cls.set(k, o);
  });
  scans.forEach(sc => {
    const s = students.get(sc.code);
    if (!s || s.active === false) {
      const k = sc.cls || '—';
      const o = cls.get(k) || { ate: 0, total: 0 };
      o.ate++; cls.set(k, o);
    }
  });
  return { scans, active, absent, cls };
}

async function renderReport() {
  const inp = $('#repDate');
  if (!inp.value) inp.value = dateStr();
  const d = inp.value;
  const { scans, active, absent, cls } = await dayData(d);
  const classes = [...cls.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ar', { numeric: true }));
  $('#repArea').innerHTML = `
    <div class="rep-title">${esc(settings.school || 'المطعم المدرسي')} — ${esc(fmtDate(d))}</div>
    <div class="tiles">
      <div class="tile"><b>${scans.length}</b><span>وجبة مسجلة</span></div>
      <div class="tile"><b>${active.length}</b><span>مسجّلون بالمطعم</span></div>
      <div class="tile"><b>${absent.length}</b><span>لم يتناولوا</span></div>
    </div>
    <table>
      <thead><tr><th>القسم</th><th class="num">تناولوا</th><th class="num">المسجلون</th><th class="num">الغياب</th></tr></thead>
      <tbody>${classes.length ? classes.map(([k, o]) => `<tr><td>${esc(k)}</td><td class="num">${o.ate}</td><td class="num">${o.total}</td><td class="num">${Math.max(0, o.total - o.ate)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">لا بيانات</td></tr>'}</tbody>
    </table>
    <details open><summary>تناولوا الوجبة (${scans.length})</summary>
      <table><thead><tr><th>الساعة</th><th>الاسم</th><th>القسم</th></tr></thead>
      <tbody>${scans.map(s => `<tr><td dir="ltr">${esc(s.time)}</td><td>${esc(s.name)}</td><td>${esc(s.cls)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">لا يوجد</td></tr>'}</tbody></table>
    </details>
    <details><summary>لم يتناولوا (${absent.length})</summary>
      <table><thead><tr><th>الاسم</th><th>القسم</th></tr></thead>
      <tbody>${absent.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.cls)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">لا يوجد</td></tr>'}</tbody></table>
    </details>`;
}
$('#repDate').addEventListener('change', renderReport);
$('#btnExportDay').addEventListener('click', async () => {
  const d = $('#repDate').value || dateStr();
  const scans = (await scansByDate(d)).sort((a, b) => a.ts - b.ts);
  if (!scans.length) { toast('لا توجد تسجيلات في هذا اليوم'); return; }
  const rows = [['التاريخ', 'الساعة', 'الرمز', 'الاسم', 'القسم'], ...scans.map(s => [s.date, s.time, s.code, s.name, s.cls])];
  downloadFile(`وجبات-${d}.csv`, toCSV(rows));
});

async function monthData(month) {
  const scans = await scansRange(month + '-01', month + '-31');
  const map = new Map();
  [...students.values()].filter(s => s.active !== false).forEach(s => map.set(s.code, { code: s.code, name: s.name, cls: s.cls || '', days: [] }));
  scans.sort((a, b) => a.ts - b.ts).forEach(sc => {
    let o = map.get(sc.code);
    if (!o) { o = { code: sc.code, name: sc.name, cls: sc.cls || '', days: [] }; map.set(sc.code, o); }
    o.days.push(sc.date.slice(8));
  });
  return { rows: [...map.values()].sort(byClassName), total: scans.length };
}
async function renderMonth() {
  const inp = $('#repMonth');
  if (!inp.value) inp.value = dateStr().slice(0, 7);
  const { rows, total } = await monthData(inp.value);
  $('#monthArea').innerHTML = `
    <div class="tiles" style="grid-template-columns:repeat(2,1fr)">
      <div class="tile"><b>${total}</b><span>مجموع الوجبات</span></div>
      <div class="tile"><b>${rows.filter(r => r.days.length).length}</b><span>تلميذ تناول وجبة</span></div>
    </div>
    <table><thead><tr><th>الاسم</th><th>القسم</th><th class="num">الوجبات</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.cls)}</td><td class="num">${r.days.length}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">لا بيانات</td></tr>'}</tbody></table>`;
}
$('#repMonth').addEventListener('change', renderMonth);
$('#btnExportMonth').addEventListener('click', async () => {
  const m = $('#repMonth').value || dateStr().slice(0, 7);
  const { rows } = await monthData(m);
  if (!rows.length) { toast('لا بيانات'); return; }
  const out = [['الاسم', 'القسم', 'الرمز', 'عدد الوجبات', 'الأيام'], ...rows.map(r => [r.name, r.cls, r.code, r.days.length, r.days.join(' ')])];
  downloadFile(`حصيلة-${m}.csv`, toCSV(out));
});

/* ---------------- الإعدادات والنسخ الاحتياطي ---------------- */
function daysSince(ts) { return Math.floor((Date.now() - ts) / 86400000); }
async function renderBackupWarn() {
  const w = $('#backupWarn');
  const n = (await req(st_('scans').count()));
  if (!n) { w.hidden = true; return; }
  if (!settings.lastBackup) { w.textContent = '⚠️ لم تحفظ نسخة احتياطية بعد. من تبويب «إعدادات» احفظ نسخة لحماية بياناتك.'; w.hidden = false; }
  else if (daysSince(settings.lastBackup) >= 14) { w.textContent = `⚠️ آخر نسخة احتياطية قبل ${daysSince(settings.lastBackup)} يومًا. احفظ نسخة جديدة من تبويب «إعدادات».`; w.hidden = false; }
  else w.hidden = true;
}
async function renderSettings() {
  $('#setSchool').value = settings.school || '';
  $('#setSound').checked = settings.sound !== false;
  $('#backupInfo').textContent = settings.lastBackup
    ? 'آخر نسخة احتياطية: ' + new Date(settings.lastBackup).toLocaleString('ar-u-nu-latn') : 'لم تُحفظ نسخة احتياطية بعد.';
  let info = '';
  try {
    if (navigator.storage && navigator.storage.persisted) {
      const p = await navigator.storage.persisted();
      info = p ? 'التخزين محمي من الحذف التلقائي.' : 'ملاحظة: قد يحذف المتصفح البيانات عند امتلاء الذاكرة، لذا احتفظ بنسخة احتياطية.';
    }
  } catch (e) { }
  $('#storageInfo').textContent = info;
}
$('#setSchool').addEventListener('change', async e => { settings.school = e.target.value.trim(); await saveSettings(); updateHeader(); toast('تم الحفظ'); });
$('#setSound').addEventListener('change', async e => { settings.sound = e.target.checked; await saveSettings(); });

$('#btnBackup').addEventListener('click', async () => {
  const data = { app: 'canteen', version: 1, exported: new Date().toISOString(), settings, students: await dbAll('students'), scans: await dbAll('scans') };
  downloadFile(`canteen-backup-${dateStr()}.json`, JSON.stringify(data), 'application/json');
  settings.lastBackup = Date.now();
  await saveSettings();
  renderSettings();
  toast('تم حفظ النسخة الاحتياطية');
});
$('#btnRestore').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse((await f.text()).replace(/^﻿/, ''));
    if (data.app !== 'canteen' || !Array.isArray(data.students) || !Array.isArray(data.scans)) throw new Error('ملف غير صالح');
    if (!confirm(`سيتم استبدال كل البيانات الحالية بالنسخة:\n${data.students.length} تلميذ و${data.scans.length} تسجيل.\nمتابعة؟`)) return;
    await dbClear('students'); await dbClear('scans');
    await bulkPut('students', data.students);
    await bulkPut('scans', data.scans);
    settings = { ...settings, ...(data.settings || {}), lastBackup: settings.lastBackup };
    await saveSettings();
    await loadStudents();
    updateHeader(); renderSettings();
    toast('تم الاسترجاع');
  } catch (err) {
    alert('تعذّر الاسترجاع: ' + err.message);
  }
});
$('#btnClearScans').addEventListener('click', async () => {
  if (prompt('سيتم حذف كل تسجيلات الوجبات نهائيًا. للتأكيد اكتب: حذف') !== 'حذف') return;
  await dbClear('scans');
  toast('تم حذف التسجيلات');
  renderSettings();
});
$('#btnClearAll').addEventListener('click', async () => {
  if (prompt('سيتم حذف التلاميذ والتسجيلات والإعدادات نهائيًا. للتأكيد اكتب: حذف') !== 'حذف') return;
  await dbClear('students'); await dbClear('scans'); await dbClear('meta');
  settings = { school: '', sound: true, lastBackup: 0 };
  await loadStudents(); updateHeader(); renderSettings();
  toast('تم حذف كل البيانات');
});

/* ---------------- الإقلاع ---------------- */
(async function init() {
  try {
    db = await openDB();
    await loadSettings();
    await loadStudents();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div class="notice">تعذّر فتح قاعدة البيانات في هذا المتصفح (ربما الوضع الخاص). افتح التطبيق في نافذة عادية.</div>');
    return;
  }
  updateHeader();
  initDetector();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  showTab('scan');
  setInterval(() => {
    if (dateStr() !== curDate) { curDate = dateStr(); updateHeader(); refreshToday(); }
  }, 30000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
})();
