// client.js — Interface simplificada estilo planilha para anunciantes
import { requireAuth, logout } from './auth.js'
import { getBookings, createBooking, updateBooking, deleteBooking, getBlockedDates } from './api.js'
import { FERIADOS_BR, BOOKING_STATUS, NEWSLETTERS, FORMATS, isDayBlocked, isSlotFree, formatDate, toISODate } from './config.js'

// ── Auth ──────────────────────────────────────────────────────────────────────
const session = requireAuth('/index.html')
if (!session) throw new Error('sem sessao')
if (session.role !== 'anunciante') { window.location.href = 'app.html'; throw new Error() }

const clientId  = session.clientId
const clientName = session.clientName || 'Anunciante'

// ── Colunas da tabela ─────────────────────────────────────────────────────────
const COLS = [
  { key: 'date',               label: 'Data',              w: 110, type: 'date' },
  { key: 'newsletter',         label: 'Newsletter',         w: 100, type: 'sel', opts: [['aurora','Aurora'],['indice','Índice']] },
  { key: 'format',             label: 'Formato',            w: 130, type: 'sel', opts: [['destaque','Destaque'],['corpo','Corpo do Email']] },
  { key: 'status',             label: 'Status',             w: 135, type: 'status' },
  { key: 'campaign_name',      label: 'Nome da Campanha',   w: 230, type: 'text' },
  { key: 'authorship',         label: 'Autoria',            w: 160, type: 'text' },
  { key: 'isbn',               label: 'ISBN',               w: 130, type: 'text' },
  { key: 'suggested_text',     label: 'Texto Sugerido',     w: 300, type: 'text' },
  { key: 'extra_info',         label: 'Informações Extras', w: 200, type: 'text' },
  { key: 'promotional_period', label: 'Período Promo',      w: 140, type: 'text' },
  { key: 'cover_link',         label: 'Link da Capa',       w: 200, type: 'text' },
  { key: 'redirect_link',      label: 'Link Redirect',      w: 200, type: 'text' },
]

// ── Estado ────────────────────────────────────────────────────────────────────
let ownBookings  = []   // bookings do cliente (para exibição)
let allBookings  = []   // todos os bookings (para checar disponibilidade)
let blockedDates = []   // datas bloqueadas pelo admin
let rows         = []   // linhas da tabela (inclui novas ainda não salvas)
let dirty        = new Set()  // IDs de linhas com alterações
let activeRowId  = null       // linha selecionada (para o calendário)
let calDate      = new Date() // mês exibido no mini calendário
let newCounter   = 0

// ── DOM refs ──────────────────────────────────────────────────────────────────
const elName    = document.getElementById('client-name')
const elSaveInd = document.getElementById('save-ind')
const elSaveBtn = document.getElementById('btn-save')
const elTable   = document.getElementById('sheet-table')
const elThead   = document.getElementById('sheet-thead')
const elTbody   = document.getElementById('sheet-tbody')
const elLoading = document.getElementById('sheet-loading')
const elAddBar  = document.getElementById('add-row-bar')
const elCalGrid = document.getElementById('cal-grid')
const elCalTtl  = document.getElementById('cal-title')
const elCalHint = document.getElementById('cal-hint')
const elToast   = document.getElementById('toast')

// ── Init ──────────────────────────────────────────────────────────────────────
elName.textContent = clientName
document.getElementById('btn-logout').addEventListener('click', logout)
elSaveBtn.addEventListener('click', saveAll)
document.getElementById('btn-add').addEventListener('click', addRow)
document.getElementById('cal-prev').addEventListener('click', () => { calDate.setMonth(calDate.getMonth() - 1); renderCal() })
document.getElementById('cal-next').addEventListener('click', () => { calDate.setMonth(calDate.getMonth() + 1); renderCal() })

async function init() {
  try {
    const [own, all, blocked] = await Promise.all([
      getBookings({ clientId }),
      getBookings({}),
      getBlockedDates(),
    ])
    ownBookings  = own     || []
    allBookings  = all     || []
    blockedDates = blocked || []

    // Inicializa linhas com estado: rascunho = editável, outros = bloqueados
    rows = ownBookings.map(b => ({ ...b, _state: b.status === 'rascunho' ? 'clean' : 'locked' }))

    buildThead()
    buildTbody()

    elLoading.style.display = 'none'
    elTable.style.display   = ''
    elAddBar.style.display  = ''

    // Navega o calendário para o mês do próximo booking
    const today = toISODate(new Date())
    const next  = ownBookings.find(b => b.date >= today)
    if (next) { const [y,m] = next.date.split('-'); calDate = new Date(+y, +m-1, 1) }
    renderCal()
  } catch (e) {
    elLoading.textContent = 'Erro ao carregar. Recarregue a página.'
    console.error(e)
  }
}

// ── Tabela ────────────────────────────────────────────────────────────────────
function buildThead() {
  const tr = document.createElement('tr')
  addTh(tr, '#', 'col-rn')
  COLS.forEach(c => { const th = addTh(tr, c.label); th.style.minWidth = c.w + 'px'; th.style.width = c.w + 'px' })
  addTh(tr, '', 'col-act')
  elThead.innerHTML = ''
  elThead.appendChild(tr)
}

function addTh(tr, text, cls) {
  const th = document.createElement('th')
  th.textContent = text
  if (cls) th.className = cls
  tr.appendChild(th)
  return th
}

function buildTbody() {
  elTbody.innerHTML = ''
  rows.forEach((row, i) => elTbody.appendChild(makeRow(row, i + 1)))
}

function makeRow(row, num) {
  const id     = rowId(row)
  const locked = row._state === 'locked'
  const tr     = document.createElement('tr')
  tr.dataset.rid = id
  tr.className   = `sheet-row state-${row._state}`

  // Número da linha
  const tdN = document.createElement('td')
  tdN.className   = 'col-rn'
  tdN.textContent = num
  tr.appendChild(tdN)

  // Colunas de dados
  COLS.forEach(col => {
    const td = document.createElement('td')
    td.dataset.key = col.key

    if (col.type === 'status') {
      const cfg = BOOKING_STATUS[row.status] || BOOKING_STATUS.rascunho
      const sp  = document.createElement('span')
      sp.className   = 's-badge'
      sp.textContent = cfg.label
      sp.style.cssText = `background:${cfg.bg};color:${cfg.color}`
      const wrap = document.createElement('div')
      wrap.className = 'cell-ro'
      wrap.appendChild(sp)
      td.appendChild(wrap)

    } else if (locked) {
      const div = document.createElement('div')
      div.className   = 'cell-ro'
      div.textContent = displayVal(col, row[col.key])
      td.appendChild(div)

    } else if (col.type === 'sel') {
      const sel = document.createElement('select')
      sel.className = 'cell-sel'
      col.opts.forEach(([v, l]) => {
        const o = document.createElement('option')
        o.value = v; o.textContent = l
        if (row[col.key] === v) o.selected = true
        sel.appendChild(o)
      })
      sel.addEventListener('focus', () => setActive(id))
      sel.addEventListener('change', () => onEdit(row, col.key, sel.value))
      td.appendChild(sel)

    } else if (col.type === 'date') {
      const inp = document.createElement('input')
      inp.type      = 'date'
      inp.className = 'cell-inp'
      inp.value     = row[col.key] || ''
      inp.addEventListener('focus', () => setActive(id))
      inp.addEventListener('change', () => onEdit(row, col.key, inp.value))
      td.appendChild(inp)

    } else {
      const inp = document.createElement('input')
      inp.type      = 'text'
      inp.className = 'cell-inp'
      inp.value     = row[col.key] || ''
      inp.addEventListener('focus', () => setActive(id))
      inp.addEventListener('input', () => onEdit(row, col.key, inp.value))
      td.appendChild(inp)
    }

    tr.appendChild(td)
  })

  // Ação: excluir
  const tdA = document.createElement('td')
  tdA.className = 'col-act'
  if (!locked) {
    const btn = document.createElement('button')
    btn.className = 'btn-del'
    btn.title     = 'Excluir linha'
    btn.textContent = '✕'
    btn.addEventListener('click', () => deleteRow(row))
    tdA.appendChild(btn)
  }
  tr.appendChild(tdA)

  return tr
}

function displayVal(col, val) {
  if (!val) return ''
  if (col.type === 'sel') return (col.opts.find(([v]) => v === val) || [])[1] || val
  if (col.type === 'date') return formatDate(val)
  return val
}

function rowId(row) { return String(row.id || row._tid) }

// ── Interações ────────────────────────────────────────────────────────────────
function setActive(id) {
  if (activeRowId === id) return
  activeRowId = id
  document.querySelectorAll('.sheet-row').forEach(tr => tr.classList.toggle('row-active', tr.dataset.rid === id))
  renderCal()
}

function onEdit(row, key, value) {
  row[key] = value
  if (row._state === 'clean') row._state = 'dirty'
  dirty.add(rowId(row))
  // Atualiza classe da linha
  const tr = document.querySelector(`[data-rid="${rowId(row)}"]`)
  if (tr) tr.className = `sheet-row state-${row._state} ${activeRowId === rowId(row) ? 'row-active' : ''}`
  updateSaveBtn()
  if (['newsletter', 'format', 'date'].includes(key)) renderCal()
}

function addRow() {
  newCounter++
  const tid  = `new-${newCounter}`
  const row  = {
    _tid: tid, _state: 'new', client_id: clientId,
    date: '', newsletter: 'aurora', format: 'destaque', status: 'rascunho',
    campaign_name: '', authorship: '', isbn: '', suggested_text: '',
    extra_info: '', promotional_period: '', cover_link: '', redirect_link: '',
  }
  rows.push(row)
  dirty.add(tid)
  updateSaveBtn()

  // Insere linha no DOM
  const num = rows.length
  const tr  = makeRow(row, num)
  elTbody.appendChild(tr)

  // Foca a célula de data da nova linha
  const dateInp = tr.querySelector('input[type="date"]')
  if (dateInp) { dateInp.focus(); setActive(tid) }
}

async function deleteRow(row) {
  if (!confirm('Excluir esta linha?')) return
  if (row.id) {
    try { await deleteBooking(row.id) }
    catch (e) { toast('Erro ao excluir: ' + e.message, 'err'); return }
    allBookings  = allBookings.filter(b => b.id !== row.id)
    ownBookings  = ownBookings.filter(b => b.id !== row.id)
  }
  const id = rowId(row)
  rows = rows.filter(r => rowId(r) !== id)
  dirty.delete(id)
  if (activeRowId === id) { activeRowId = null }

  // Remove linha do DOM e renumera
  const tr = document.querySelector(`[data-rid="${id}"]`)
  if (tr) tr.remove()
  renumber()
  updateSaveBtn()
  renderCal()
}

function renumber() {
  elTbody.querySelectorAll('.sheet-row').forEach((tr, i) => {
    const td = tr.querySelector('.col-rn')
    if (td) td.textContent = i + 1
  })
}

// ── Salvar ────────────────────────────────────────────────────────────────────
function updateSaveBtn() {
  const n = dirty.size
  elSaveBtn.disabled  = n === 0
  elSaveBtn.textContent = n > 0 ? `Salvar (${n})` : 'Salvar'
  elSaveInd.textContent = n > 0 ? `${n} alteraç${n === 1 ? 'ão' : 'ões'} não salva${n === 1 ? '' : 's'}` : ''
}

async function saveAll() {
  if (!dirty.size) return
  elSaveBtn.disabled    = true
  elSaveBtn.textContent = 'Salvando…'
  elSaveInd.textContent = ''

  const errors = []

  for (const id of [...dirty]) {
    const row = rows.find(r => rowId(r) === id)
    if (!row) continue

    const payload = {
      date: row.date, newsletter: row.newsletter, format: row.format,
      campaign_name:      row.campaign_name      || '',
      authorship:         row.authorship         || '',
      isbn:               row.isbn               || '',
      suggested_text:     row.suggested_text     || '',
      extra_info:         row.extra_info         || '',
      promotional_period: row.promotional_period || '',
      cover_link:         row.cover_link         || '',
      redirect_link:      row.redirect_link      || '',
    }

    try {
      if (row.id) {
        await updateBooking(row.id, payload)
        row._state = 'clean'
      } else {
        const created = await createBooking({ ...payload, client_id: clientId, status: 'rascunho' })
        // Promove o tid para id real
        row.id = created.id
        delete row._tid
        row._state = 'clean'
        allBookings.push({ ...row })
        ownBookings.push({ ...row })
        // Atualiza data-rid no DOM
        const tr = document.querySelector(`[data-rid="${id}"]`)
        if (tr) tr.dataset.rid = String(row.id)
      }
      // Atualiza classe da linha
      const tr = document.querySelector(`[data-rid="${rowId(row)}"]`)
      if (tr) tr.className = `sheet-row state-clean`
    } catch (e) {
      errors.push(`${row.date || '?'}: ${e.message}`)
    }
  }

  dirty.clear()
  updateSaveBtn()
  renderCal()

  if (errors.length) toast('Erros: ' + errors.join(' | '), 'err')
  else               toast('Salvo!', 'ok')
}

// ── Mini Calendário ───────────────────────────────────────────────────────────
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

function renderCal() {
  const y = calDate.getFullYear()
  const m = calDate.getMonth()
  elCalTtl.textContent = `${MESES[m]} ${y}`

  const activeRow = rows.find(r => rowId(r) === activeRowId)
  const aNL  = activeRow?.newsletter || null
  const aFmt = activeRow?.format     || null

  // Datas com bookings do próprio cliente
  const ownDates = new Set(ownBookings.map(b => b.date))
  // Datas selecionadas na tabela (do cliente, linhas dirty/new também)
  const rowDates = new Set(rows.map(r => r.date).filter(Boolean))

  // Bookings de OUTROS clientes (para checar disponibilidade do slot ativo)
  const othersBookings = allBookings.filter(b => b.client_id !== clientId)

  elCalGrid.innerHTML = ''

  // Cabeçalho: Seg a Dom
  ;['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].forEach(d => {
    const h = document.createElement('div')
    h.className   = 'cal-wd'
    h.textContent = d
    elCalGrid.appendChild(h)
  })

  // Offset do primeiro dia (segunda = 0)
  const firstDow    = new Date(y, m, 1).getDay() // 0=Dom
  const startOffset = firstDow === 0 ? 6 : firstDow - 1
  for (let i = 0; i < startOffset; i++) {
    const e = document.createElement('div')
    e.className = 'cal-d'
    elCalGrid.appendChild(e)
  }

  const today       = toISODate(new Date())
  const daysInMonth = new Date(y, m + 1, 0).getDate()

  for (let d = 1; d <= daysInMonth; d++) {
    const ds  = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(ds + 'T12:00:00').getDay()
    const isWE = dow === 0 || dow === 6
    const isHol = FERIADOS_BR.includes(ds) || blockedDates.some(b => b.date === ds)
    const isBlocked = isWE || isHol
    const isOwn = rowDates.has(ds) || ownDates.has(ds)
    const isToday = ds === today
    const isSel = activeRow?.date === ds

    // Disponibilidade do slot ativo
    let taken = false
    if (aNL && aFmt && !isBlocked) {
      taken = !isSlotFree(ds, aNL, aFmt, othersBookings)
    }

    const el = document.createElement('div')
    el.textContent = d
    el.className   = 'cal-d'

    if (isBlocked)      el.classList.add('blocked')
    else if (taken)     el.classList.add('taken')
    else if (aNL && aFmt) el.classList.add('free')

    if (isOwn)    el.classList.add('own')
    if (isToday)  el.classList.add('today')
    if (isSel)    el.classList.add('sel')

    if (!isBlocked) {
      el.classList.add('clickable')
      el.addEventListener('click', () => setDateOnActiveRow(ds))
    }

    elCalGrid.appendChild(el)
  }

  // Dica contextual
  if (aNL && aFmt) {
    const nlLabel  = NEWSLETTERS[aNL]?.label  || aNL
    const fmtLabel = FORMATS[aFmt]?.label     || aFmt
    elCalHint.textContent = `Clique numa data para ${nlLabel} · ${fmtLabel}`
  } else {
    elCalHint.textContent = 'Selecione uma linha para ver disponibilidade'
  }
}

function setDateOnActiveRow(ds) {
  if (!activeRowId) return

  const row = rows.find(r => rowId(r) === activeRowId)
  if (!row || row._state === 'locked') return

  onEdit(row, 'date', ds)

  // Atualiza o input de data no DOM
  const tr = document.querySelector(`[data-rid="${rowId(row)}"]`)
  if (tr) {
    const inp = tr.querySelector('input[type="date"]')
    if (inp) inp.value = ds
  }

  // Navega calendário se mudou de mês
  const [ny, nm] = ds.split('-')
  if (+ny !== calDate.getFullYear() || +nm - 1 !== calDate.getMonth()) {
    calDate = new Date(+ny, +nm - 1, 1)
  }
  renderCal()
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastT
function toast(msg, type = 'info') {
  elToast.textContent = msg
  elToast.className   = `toast ${type} show`
  clearTimeout(_toastT)
  _toastT = setTimeout(() => elToast.classList.remove('show'), 3000)
}

// ── Arranque ──────────────────────────────────────────────────────────────────
init()
