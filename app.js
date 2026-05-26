// tabulator — solid-apps/tabulator
//
// A tiny spreadsheet for your pod, in the spirit of TimBL's Tabulator: cells can
// dereference a URI to pull a live value from the data web.
//
//   =SUM(B2:B9)   =AVG(A1:A5)   =A1*1.2+B1   =MIN(..) =MAX(..) =COUNT(..)
//   =GET("https://pod/data#thing", "schema:price")   ← follow the URI, read a literal
//
// The =GET function fetches the subject URI (tolerant JSON-LD, like the rest of
// the suite), finds the subject by fragment, and returns the object of the given
// predicate (curie / bare / full-URI tolerant). A bare URI in a cell renders as
// a clickable link. CORS works for your pod + CORS-friendly Solid data; arbitrary
// web resources may need a proxy (a follow-up).
//
// A sheet is one JSON-LD doc at /public/sheet/<slug>.jsonld, registered in your
// TypeIndex as urn:solid:Spreadsheet so hub/pilot can discover it.

const COLS = 26, ROWS = 100
const SHEET_CLASS = 'urn:solid:Spreadsheet'
const SOLID_NS = 'http://www.w3.org/ns/solid/terms#'
const PIM_NS = 'http://www.w3.org/ns/pim/space#'
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const TAB_NS = 'urn:solid:tabulator#'
const PREFIXES = {
  schema: 'https://schema.org/', foaf: 'http://xmlns.com/foaf/0.1/',
  vcard: 'http://www.w3.org/2006/vcard/ns#', ical: 'http://www.w3.org/2002/12/cal/ical#',
  dc: 'http://purl.org/dc/elements/1.1/', dcterms: 'http://purl.org/dc/terms/',
  ldp: 'http://www.w3.org/ns/ldp#', acl: 'http://www.w3.org/ns/auth/acl#',
  wf: 'http://www.w3.org/2005/01/wf/flow#', as: 'https://www.w3.org/ns/activitystreams#',
  bookmark: 'http://www.w3.org/2002/01/bookmark#', rdf: RDF_NS, rdfs: 'http://www.w3.org/2000/01/rdf-schema#'
}

const authFetch = (url, opts) => ((window.xlogin && window.xlogin.authFetch) || fetch)(url, opts)
const loggedIn = () => !!(window.xlogin && window.xlogin.id)
const myWebId = () => (window.xlogin && window.xlogin.id) || null
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// =====================================================================
// pod helpers (ported from hub/camera)
// =====================================================================
const idOf = (v) => typeof v === 'string' ? v : (v && v['@id']) || null
function valueOf(v) { if (v == null) return null; if (typeof v !== 'object') return v; if (Array.isArray(v)) return v.length ? valueOf(v[0]) : null; return v['@value'] ?? v['@id'] ?? null }
function isHttpUrl(s) { try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' } catch { return false } }
function parseLoose(s) { try { return JSON.parse(s) } catch { try { return JSON.parse(s.replace(/,(\s*[\}\]])/g, '$1')) } catch (e) { throw new Error('JSON-LD parse') } } }
function findSubject(doc, frag) { const g = Array.isArray(doc['@graph']) ? doc['@graph'] : Array.isArray(doc) ? doc : [doc]; if (frag) { const m = g.find((n) => (n['@id'] || '').endsWith('#' + frag)); if (m) return m } return g[0] || {} }
async function getJsonLd(url) {
  const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } })
  if (r.status === 404) return null
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('ld+json') || ct.includes('application/json')) return r.json()
  if (ct.includes('text/html')) { const m = (await r.text()).match(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/i); return m ? parseLoose(m[1].trim()) : null }
  throw new Error('not JSON-LD')
}
async function putJsonLd(url, body) { const r = await authFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify(body, null, 2) }); if (!r.ok) throw new Error('PUT ' + r.status); return r }
async function ensureContainer(url) { const u = url.replace(/\/?$/, '/'); const h = await authFetch(u, { method: 'HEAD' }).catch(() => null); if (h && h.ok) return; const r = await authFetch(u, { method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '' }); if (!r.ok && r.status !== 409) throw new Error('container ' + r.status) }
async function discoverStorage(webid) {
  if (!isHttpUrl(webid)) return null
  try { const url = webid.replace(/#.*$/, ''); const doc = await getJsonLd(url); if (doc) { const s = findSubject(doc, webid.includes('#') ? webid.split('#')[1] : null); const id = valueOf(s['pim:storage'] ?? s[PIM_NS + 'storage'] ?? s['space:storage'] ?? s['storage']); if (id) { try { return new URL(id, url).href.replace(/\/?$/, '/') } catch { return id.replace(/\/?$/, '/') } } } } catch {}
  try { return new URL(webid).origin + '/' } catch { return null }
}
async function fetchTypeIndex(webid) {
  const doc = await getJsonLd(webid.replace(/#.*$/, '')); if (!doc) return null
  const s = findSubject(doc, webid.includes('#') ? webid.split('#')[1] : null)
  const tiId = idOf(s['solid:publicTypeIndex'] ?? s[SOLID_NS + 'publicTypeIndex'] ?? s['publicTypeIndex']); if (!tiId) return null
  const tiUrl = new URL(tiId, webid).href
  const ti = await getJsonLd(tiUrl).catch(() => null); if (!ti) return { typeIndexUrl: tiUrl, registrations: [] }
  const nodes = []; const collect = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(collect); return } if (x['solid:forClass'] || x[SOLID_NS + 'forClass']) nodes.push(x); for (const v of Object.values(x)) if (typeof v === 'object') collect(v) }; collect(ti)
  const regs = nodes.map((n) => ({ forClass: idOf(n['solid:forClass'] ?? n[SOLID_NS + 'forClass']), instance: idOf(n['solid:instance'] ?? n[SOLID_NS + 'instance']) })).filter((r) => r.forClass && r.instance)
  regs.forEach((r) => { if (!/^https?:/.test(r.instance)) r.instance = new URL(r.instance, tiUrl).href })
  return { typeIndexUrl: tiUrl, registrations: regs }
}
async function addTypeRegistration(typeIndexUrl, { forClass, instance }) {
  const doc = await getJsonLd(typeIndexUrl); if (!doc) throw new Error('TypeIndex not found')
  const reg = { '@id': '#reg-' + Math.random().toString(36).slice(2, 9), '@type': 'solid:TypeRegistration', 'solid:forClass': { '@id': forClass }, 'solid:instance': { '@id': instance } }
  if (Array.isArray(doc['schema:itemListElement'])) doc['schema:itemListElement'].push(reg)
  else if (Array.isArray(doc['@graph'])) doc['@graph'].push(reg)
  else doc['schema:itemListElement'] = [reg]
  await putJsonLd(typeIndexUrl, doc)
}
const slugify = (s) => String(s || '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

// =====================================================================
// cell refs
// =====================================================================
function colName(c) { return String.fromCharCode(65 + c) }           // 0→A
function colNum(s) { return s.toUpperCase().charCodeAt(0) - 65 }      // A→0
function parseRef(ref) { const m = /^([A-Za-z])(\d+)$/.exec(ref); return m ? { c: colNum(m[1]), r: +m[2] - 1 } : null }
function refStr(c, r) { return colName(c) + (r + 1) }
function expandRange(a, b) {
  const A = parseRef(a), B = parseRef(b); if (!A || !B) return []
  const out = []; for (let r = Math.min(A.r, B.r); r <= Math.max(A.r, B.r); r++) for (let c = Math.min(A.c, B.c); c <= Math.max(A.c, B.c); c++) out.push(refStr(c, r))
  return out
}

// =====================================================================
// formula engine (recursive-descent, no eval, cycle-guarded)
// =====================================================================
const SHEET = { url: null, name: '', cells: {} }
let computed = new Map(), computing = new Set()
const GET_CACHE = new Map()   // "uri\npred" → value (or undefined while pending)
const GET_PENDING = new Set()

function tokenize(s) {
  const t = []; let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '"' || c === "'") { let j = i + 1, str = ''; while (j < s.length && s[j] !== c) str += s[j++]; i = j + 1; t.push({ t: 'str', v: str }); continue }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; t.push({ t: 'num', v: parseFloat(s.slice(i, j)) }); i = j; continue }
    if (/[A-Za-z]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++; t.push({ t: 'id', v: s.slice(i, j) }); i = j; continue }
    if ('+-*/(),:'.includes(c)) { t.push({ t: 'op', v: c }); i++; continue }
    throw '#ERR'
  }
  return t
}
const numify = (v) => { if (typeof v === 'number') return v; const n = Number(v); return (v === '' || v == null || isNaN(n)) ? NaN : n }

function evalFormula(src) {
  const toks = tokenize(src); let p = 0
  const peek = () => toks[p], eat = () => toks[p++], expect = (o) => { const k = eat(); if (!k || k.v !== o) throw '#ERR' }
  function expr() { let v = term(); while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) { const o = eat().v; const r = term(); v = o === '+' ? numify(v) + numify(r) : numify(v) - numify(r) } return v }
  function term() { let v = factor(); while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) { const o = eat().v; const r = factor(); v = o === '*' ? numify(v) * numify(r) : numify(v) / numify(r) } return v }
  function factor() {
    const k = peek(); if (!k) throw '#ERR'
    if (k.t === 'op' && k.v === '(') { eat(); const v = expr(); expect(')'); return v }
    if (k.t === 'op' && k.v === '-') { eat(); return -numify(factor()) }
    if (k.t === 'num') { eat(); return k.v }
    if (k.t === 'str') { eat(); return k.v }
    if (k.t === 'id') { eat(); if (peek() && peek().v === '(') return call(k.v.toUpperCase()); return refVal(k.v) }
    throw '#ERR'
  }
  function args() { expect('('); const a = []; if (peek() && peek().v === ')') { eat(); return a } do { a.push(arg()) } while (peek() && peek().v === ',' && eat()); expect(')'); return a }
  function arg() {
    const k = peek()
    if (k && k.t === 'id' && toks[p + 1] && toks[p + 1].v === ':') { const A = eat().v; eat(); const B = eat().v; return { range: [A, B] } }
    if (k && k.t === 'str') { eat(); return { str: k.v } }
    return { val: expr() }
  }
  function call(name) {
    const a = args()
    if (name === 'GET') return getValue(a[0] && (a[0].str ?? a[0].val), a[1] && (a[1].str ?? a[1].val))
    const nums = []
    for (const x of a) {
      if (x.range) { for (const ref of expandRange(x.range[0], x.range[1])) { const n = numify(refVal(ref)); if (!isNaN(n)) nums.push(n) } }
      else { const n = numify(x.val); if (!isNaN(n)) nums.push(n) }
    }
    if (name === 'SUM') return nums.reduce((s, x) => s + x, 0)
    if (name === 'COUNT') return nums.length
    if (name === 'AVG') return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : 0
    if (name === 'MIN') return nums.length ? Math.min(...nums) : 0
    if (name === 'MAX') return nums.length ? Math.max(...nums) : 0
    throw '#NAME'
  }
  const out = expr(); if (p < toks.length) throw '#ERR'; return out
}
function refVal(ref) { if (!parseRef(ref)) throw '#REF'; return evalCell(ref) }
function getValue(uri, pred) {
  if (!uri) return '#GET'
  const key = uri + '\n' + (pred || '')
  if (GET_CACHE.has(key)) { const v = GET_CACHE.get(key); return v == null ? '#GET?' : v }
  kickGet(uri, pred || '')   // fetch then re-render
  return '…'
}

function evalCell(ref) {
  if (computed.has(ref)) return computed.get(ref)
  const raw = SHEET.cells[ref]
  if (raw == null || raw === '') { computed.set(ref, ''); return '' }
  if (typeof raw === 'string' && raw[0] === '=') {
    if (computing.has(ref)) throw '#CYCLE'
    computing.add(ref)
    let v; try { v = evalFormula(raw.slice(1)) } catch (e) { v = typeof e === 'string' ? e : '#ERR' }
    computing.delete(ref)
    if (typeof v === 'number' && !isFinite(v)) v = isNaN(v) ? '#VAL' : v
    computed.set(ref, v); return v
  }
  const n = Number(raw); const v = (raw !== '' && !isNaN(n)) ? n : raw
  computed.set(ref, v); return v
}
const fmtNum = (n) => { if (!isFinite(n)) return String(n); return String(Math.round(n * 1e6) / 1e6) }
function display(ref) { let v; try { v = evalCell(ref) } catch (e) { v = typeof e === 'string' ? e : '#ERR' } return typeof v === 'number' ? fmtNum(v) : String(v) }

// --- =GET fetching (async, out of band) ---
function expandPred(pred) {
  const out = [pred]
  if (pred.includes(':')) { const [pfx, ...rest] = pred.split(':'); const loc = rest.join(':'); if (PREFIXES[pfx]) out.push(PREFIXES[pfx] + loc); out.push(loc) }
  if (pred.startsWith('https://schema.org/')) out.push('http://schema.org/' + pred.slice(19))
  if (pred.startsWith('http://schema.org/')) out.push('https://schema.org/' + pred.slice(18))
  return out
}
function readPred(subj, pred) {
  for (const k of expandPred(pred)) if (subj[k] != null) { const v = valueOf(subj[k]); if (v != null) return v }
  return null
}
async function kickGet(uri, pred) {
  const key = uri + '\n' + pred
  if (GET_PENDING.has(key) || GET_CACHE.has(key)) return
  GET_PENDING.add(key)
  try {
    const docUrl = uri.replace(/#.*$/, '')
    const doc = await getJsonLd(docUrl)
    if (!doc) { GET_CACHE.set(key, '#404'); }
    else if (!pred) { const subj = findSubject(doc, uri.includes('#') ? uri.split('#')[1] : null); const v = valueOf(subj['rdf:value'] ?? subj[RDF_NS + 'value']); GET_CACHE.set(key, v != null ? v : uri) }   // no predicate → the cell value (rdf:value), else echo the URI
    else { const subj = findSubject(doc, uri.includes('#') ? uri.split('#')[1] : null); const v = readPred(subj, pred); GET_CACHE.set(key, v == null ? '#PRED' : v) }
  } catch (e) { GET_CACHE.set(key, '#GET!') }
  GET_PENDING.delete(key)
  recompute(); renderGrid()
}
function gatherGets() {
  const re = /GET\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*\)/g
  for (const raw of Object.values(SHEET.cells)) {
    if (typeof raw !== 'string' || raw[0] !== '=') continue
    let m; re.lastIndex = 0
    while ((m = re.exec(raw))) kickGet(m[1], m[2])
  }
}
function recompute() { computed = new Map(); computing = new Set() }

// =====================================================================
// sheets: discover / create / load / save
// =====================================================================
const state = { view: 'list', sheets: [], sel: 'A1', loading: false, error: null }

async function discoverSheets() {
  const webid = myWebId(); if (!webid) return []
  const ti = await fetchTypeIndex(webid).catch(() => null); if (!ti) return []
  return ti.registrations.filter((r) => r.forClass === SHEET_CLASS && r.instance)
    .map((r) => ({ url: r.instance.replace(/#.*$/, ''), name: nameFromUrl(r.instance) }))
}
const nameFromUrl = (u) => decodeURIComponent(u.replace(/#.*$/, '').split('/').pop().replace(/\.jsonld$/, '')).replace(/-/g, ' ')

async function createSheet(name) {
  const webid = myWebId(); const storage = await discoverStorage(webid); if (!storage) throw new Error("Couldn't find your pod root")
  const slug = slugify(name); if (!slug) throw new Error('Enter a name')
  const url = `${storage}public/sheet/${slug}.jsonld`
  await ensureContainer(`${storage}public/`).catch(() => {}); await ensureContainer(`${storage}public/sheet/`).catch(() => {})
  await putJsonLd(url, emptyDoc(name))
  const ti = await fetchTypeIndex(webid); if (ti) await addTypeRegistration(ti.typeIndexUrl, { forClass: SHEET_CLASS, instance: url + '#this' })
  return url
}
function emptyDoc(name) {
  return { '@context': { schema: 'https://schema.org/', urn: 'urn:solid:' }, '@graph': [{ '@id': '#this', '@type': 'urn:Spreadsheet', 'schema:name': name, cols: COLS, rows: ROWS }] }
}
// Each non-empty cell is its own fragment subject (#A1, #B5, …): rdf:value is the
// materialised value other sheets/apps dereference, tab:src is the raw input we
// reload for editing. So every cell is an addressable URI on the data web — a
// step toward TimBL's Tabulator, where you follow your nose from cell to cell.
function sheetDoc() {
  recompute()
  const graph = [{ '@id': '#this', '@type': 'urn:Spreadsheet', 'schema:name': SHEET.name, cols: COLS, rows: ROWS }]
  for (const ref of Object.keys(SHEET.cells)) {
    const raw = SHEET.cells[ref]; if (raw == null || raw === '') continue
    let val; try { val = evalCell(ref) } catch { val = '' }
    if (typeof val === 'number' && !isFinite(val)) val = '#VAL'
    graph.push({ '@id': '#' + ref, 'rdf:value': val, 'tab:src': raw })
  }
  return { '@context': { schema: 'https://schema.org/', urn: 'urn:solid:', rdf: RDF_NS, tab: TAB_NS }, '@graph': graph }
}
async function loadSheet(url) {
  const doc = await getJsonLd(url)
  const graph = doc ? (Array.isArray(doc['@graph']) ? doc['@graph'] : Array.isArray(doc) ? doc : [doc]) : []
  const meta = graph.find((n) => (n['@id'] || '').endsWith('#this')) || graph[0] || {}
  SHEET.url = url
  SHEET.name = meta['schema:name'] || meta.name || nameFromUrl(url)
  SHEET.cells = {}
  if (meta.cells && typeof meta.cells === 'object') { SHEET.cells = { ...meta.cells } }   // legacy blob shape
  else for (const n of graph) {
    const m = /#([A-Z]\d+)$/.exec(n['@id'] || '')
    if (!m) continue
    const src = n['tab:src'] ?? n[TAB_NS + 'src']
    const val = valueOf(n['rdf:value'] ?? n[RDF_NS + 'value'])
    SHEET.cells[m[1]] = src != null ? src : (val != null ? String(val) : '')
  }
  GET_CACHE.clear(); GET_PENDING.clear()
}
let saveTimer = null
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 800) }
async function doSave() {
  if (!SHEET.url) return
  try { await putJsonLd(SHEET.url, sheetDoc()) } catch (e) { toast('Save failed: ' + e.message) }
}

// =====================================================================
// UI
// =====================================================================
const appEl = document.getElementById('app')
function toast(msg, ms = 2800) { const el = document.getElementById('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => el.hidden = true, ms) }

function render() {
  if (!loggedIn()) {
    appEl.innerHTML = `<div class="card welcome"><h2>A spreadsheet that follows URIs</h2>
      <p>Simple sums and arithmetic, plus the Tabulator trick:
         <code>=GET("https://pod/data#thing","schema:price")</code> pulls a <b>live value</b>
         from anywhere on the data web into a cell. Sheets save to your pod.
         <b>Sign in</b> (login pill, bottom-right) to start.</p></div>`
    return
  }
  if (state.error) { appEl.innerHTML = `<div class="card error">${esc(state.error)}</div>`; return }
  if (state.loading) { appEl.innerHTML = `<div class="card muted">Loading…</div>`; return }
  if (state.view === 'grid') return renderSheet()
  // list
  const items = state.sheets.map((s) => `<button class="sheet" data-open="${esc(s.url)}"><span class="ico">▦</span>${esc(s.name)}</button>`).join('')
  appEl.innerHTML = `<div class="bar"><h2 class="h">Sheets</h2><span class="spacer"></span><button class="go" id="new">+ New sheet</button></div>
    ${state.sheets.length ? `<div class="sheet-grid">${items}</div>` : `<div class="card muted">No sheets yet. Create one to start.</div>`}`
  const nb = document.getElementById('new'); if (nb) nb.onclick = onNew
  appEl.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openSheet(b.dataset.open))
}

function renderSheet() {
  recompute(); gatherGets()
  let head = '<tr><th class="corner"></th>'
  for (let c = 0; c < COLS; c++) head += `<th>${colName(c)}</th>`
  head += '</tr>'
  let body = ''
  for (let r = 0; r < ROWS; r++) {
    body += `<tr><th class="rownum">${r + 1}</th>`
    for (let c = 0; c < COLS; c++) {
      const ref = refStr(c, r), raw = SHEET.cells[ref]
      const disp = display(ref)
      const isUri = typeof raw === 'string' && /^https?:\/\//.test(raw)
      const cls = (state.sel === ref ? 'sel ' : '') + (typeof evalCellSafe(ref) === 'number' ? 'num ' : '') + (String(disp).startsWith('#') ? 'err' : '')
      const content = isUri ? `<a href="${esc(raw)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(raw.length > 28 ? raw.slice(0, 27) + '…' : raw)}</a>` : esc(disp)
      body += `<td class="${cls.trim()}" data-ref="${ref}" title="${esc(raw || '')}">${content}</td>`
    }
    body += '</tr>'
  }
  appEl.innerHTML = `
    <div class="bar">
      <button class="mini" id="back">← Sheets</button>
      <b class="sname">${esc(SHEET.name)}</b>
      <span class="spacer"></span>
      <span class="muted hint">=SUM(A1:A5) · =A1*2 · =GET("uri","schema:name")</span>
    </div>
    <div class="fxbar"><span class="cellref" id="cref">${state.sel}</span><input id="fx" autocomplete="off" spellcheck="false" value="${esc(SHEET.cells[state.sel] || '')}"></div>
    <div class="grid-scroll"><table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
  wireSheet()
}
function evalCellSafe(ref) { try { return evalCell(ref) } catch { return '#ERR' } }

function wireSheet() {
  document.getElementById('back').onclick = () => { doSave(); state.view = 'list'; render() }
  const fx = document.getElementById('fx')
  fx.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(fx.value); move(1, 0) }
    else if (e.key === 'Escape') { e.preventDefault(); fx.value = SHEET.cells[state.sel] || ''; fx.blur() }
  }
  appEl.querySelectorAll('[data-ref]').forEach((td) => td.onclick = () => select(td.dataset.ref))
  document.addEventListener('keydown', gridKeys)
}
function gridKeys(e) {
  if (state.view !== 'grid') return
  const fx = document.getElementById('fx'); if (!fx) return
  if (document.activeElement === fx) return
  const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
  if (d) { e.preventDefault(); move(d[0], d[1]); return }
  if (e.key === 'Enter') { e.preventDefault(); fx.focus(); fx.select(); return }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); commit(''); return }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { fx.value = e.key; fx.focus() } // start typing
}
function select(ref) { state.sel = ref; const cref = document.getElementById('cref'), fx = document.getElementById('fx'); if (cref) cref.textContent = ref; if (fx) fx.value = SHEET.cells[ref] || ''; highlight() }
function highlight() { appEl.querySelectorAll('td.sel').forEach((t) => t.classList.remove('sel')); const td = appEl.querySelector(`td[data-ref="${state.sel}"]`); if (td) td.classList.add('sel') }
function move(dr, dc) { const { c, r } = parseRef(state.sel); const nc = Math.max(0, Math.min(COLS - 1, c + dc)), nr = Math.max(0, Math.min(ROWS - 1, r + dr)); select(refStr(nc, nr)); const td = appEl.querySelector(`td[data-ref="${state.sel}"]`); if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
function commit(val) {
  val = val.trim()
  if (val === '') delete SHEET.cells[state.sel]; else SHEET.cells[state.sel] = val
  saveSoon(); renderGrid()
}
function renderGrid() { if (state.view === 'grid') { renderSheet(); highlight() } }

async function onNew() {
  const name = prompt('Sheet name:'); if (!name) return
  try { const url = await createSheet(name); toast('Created'); state.sheets = await discoverSheets(); openSheet(url) }
  catch (e) { toast('Create failed: ' + e.message) }
}
async function openSheet(url) {
  state.loading = true; render()
  try { await loadSheet(url); state.view = 'grid'; state.sel = 'A1' } catch (e) { state.error = e.message }
  state.loading = false; render()
}

// =====================================================================
// init
// =====================================================================
async function boot() {
  if (!loggedIn()) { render(); return }
  state.loading = true; state.error = null; render()
  try { state.sheets = await discoverSheets() } catch (e) { state.error = String(e.message || e) }
  state.loading = false; render()
}
document.addEventListener('xlogin', boot)
document.addEventListener('xlogout', () => { state.sheets = []; state.view = 'list'; render() })
boot()
