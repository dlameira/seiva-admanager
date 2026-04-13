// client.js — Interface planilha para anunciantes
import { requireAuth, logout } from './auth.js'
import { getBookings, createBooking, updateBooking, deleteBooking, getBlockedDates } from './api.js'
import { FERIADOS_BR, BOOKING_STATUS, NEWSLETTERS, FORMATS, isSlotFree, formatDate, toISODate } from './config.js'

// ── Auth ──────────────────────────────────────────────────────────────────────
const session = requireAuth('/index.html')
if (!session) throw new Error()
if (session.role !== 'anunciante') { window.location.href = 'app.html'; throw new Error() }

const clientId   = session.clientId
const clientName = session.clientName || 'Anunciante'

// ── Colunas ───────────────────────────────────────────────────────────────────
const COLS = [
  { key: 'date',               label: 'Data',              w: 108, type: 'date' },
  { key: 'newsletter',         label: 'Newsletter',         w:  96, type: 'sel', opts: [['aurora','Aurora'],['indice','Índice']] },
  { key: 'format',             label: 'Formato',            w: 120, type: 'sel', opts: [['destaque','Destaque'],['corpo','Corpo do Email']] },
  { key: 'status',             label: 'Status',             w: 130, type: 'badge' },
  { key: 'campaign_name',      label: 'Nome da Campanha',   w: 220, type: 'text' },
  { key: 'authorship',         label: 'Autoria',            w: 158, type: 'text' },
  { key: 'isbn',               label: 'ISBN',               w: 120, type: 'text' },
  { key: 'suggested_text',     label: 'Texto Sugerido',     w: 290, type: 'text' },
  { key: 'extra_info',         label: 'Informações Extras', w: 200, type: 'text' },
  { key: 'promotional_period', label: 'Período Promo',      w: 138, type: 'text' },
  { key: 'cover_link',         label: 'Link da Capa',       w: 190, type: 'text' },
  { key: 'redirect_link',      label: 'Link Redirect',      w: 190, type: 'text' },
]
const DATE_CI     = COLS.findIndex(c => c.type === 'date')
const EDITABLE_CI = COLS.map((c,i) => c.type !== 'badge' ? i : -1).filter(i => i >= 0)

// ── Estado ────────────────────────────────────────────────────────────────────
let rows        = []
let allBookings = []
let blocked     = []
let dirty       = new Set()
let active      = null   // { ri, ci } — célula com editor aberto
let activeKey   = null   // rowKey da linha ativa (sobrevive ao sort)
let calDate     = new Date()
let newCnt      = 0

// ── DOM ───────────────────────────────────────────────────────────────────────
const $name    = document.getElementById('client-name')
const $ind     = document.getElementById('save-ind')
const $save    = document.getElementById('btn-save')
const $table   = document.getElementById('sheet-table')
const $thead   = document.getElementById('sheet-thead')
const $tbody   = document.getElementById('sheet-tbody')
const $loading = document.getElementById('sheet-loading')
const $addBar  = document.getElementById('add-row-bar')
const $grid    = document.getElementById('cal-grid')
const $calTtl  = document.getElementById('cal-title')
const $calHint = document.getElementById('cal-hint')
const $toast   = document.getElementById('toast')

$name.textContent = clientName
document.getElementById('btn-logout').addEventListener('click', logout)
$save.addEventListener('click', saveAll)
document.getElementById('btn-add').addEventListener('click', addRow)
document.getElementById('cal-prev').addEventListener('click', () => { calDate.setMonth(calDate.getMonth()-1); renderCal() })
document.getElementById('cal-next').addEventListener('click', () => { calDate.setMonth(calDate.getMonth()+1); renderCal() })

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [own, all, blk] = await Promise.all([
      getBookings({ clientId }),
      getBookings({}),
      getBlockedDates(),
    ])
    rows        = (own || []).map(b => ({ ...b }))
    allBookings = all || []
    blocked     = blk || []

    buildThead()
    buildTbody()

    $loading.style.display = 'none'
    $table.style.display   = ''
    $addBar.style.display  = ''

    const today = toISODate(new Date())
    const next  = rows.find(r => r.date >= today)
    if (next) { const [y,m] = next.date.split('-'); calDate = new Date(+y,+m-1,1) }
    renderCal()
  } catch(e) {
    $loading.textContent = 'Erro ao carregar. Recarregue a página.'
    console.error(e)
  }
}

// ── Cabeçalho ─────────────────────────────────────────────────────────────────
function buildThead() {
  $thead.innerHTML = ''
  const tr = document.createElement('tr')
  mkTh(tr, '', 'col-rn')
  COLS.forEach(c => { const th = mkTh(tr, c.label); th.style.minWidth = th.style.width = c.w+'px' })
  mkTh(tr, '', 'col-act')
  $thead.appendChild(tr)
}
function mkTh(tr, txt, cls) {
  const th = document.createElement('th')
  th.textContent = txt; if (cls) th.className = cls
  tr.appendChild(th); return th
}

// ── Linhas ────────────────────────────────────────────────────────────────────
function buildTbody() {
  $tbody.innerHTML = ''
  rows.forEach((row, ri) => $tbody.appendChild(buildTr(row, ri)))
}

function buildTr(row, ri) {
  const tr = document.createElement('tr')
  tr.className  = 'sheet-row'
  tr.dataset.ri = ri
  if (dirty.has(rowKey(row))) tr.classList.add('row-dirty')
  if (activeKey === rowKey(row)) tr.classList.add('row-active')

  const tdN = document.createElement('td')
  tdN.className = 'col-rn'; tdN.textContent = ri+1
  tr.appendChild(tdN)

  COLS.forEach((col, ci) => tr.appendChild(buildTd(row, ri, col, ci)))

  const tdA = document.createElement('td'); tdA.className = 'col-act'
  const btn = document.createElement('button')
  btn.className = 'btn-del'; btn.textContent = '✕'; btn.title = 'Excluir'
  btn.addEventListener('mousedown', e => { e.preventDefault(); deleteRow(ri) })
  tdA.appendChild(btn); tr.appendChild(tdA)
  return tr
}

function buildTd(row, ri, col, ci) {
  const td = document.createElement('td')
  td.dataset.ri = ri; td.dataset.ci = ci

  if (col.type === 'badge') {
    const cfg = BOOKING_STATUS[row.status] || BOOKING_STATUS.rascunho
    const wrap = document.createElement('div'); wrap.className = 'cell-disp'
    const sp = document.createElement('span'); sp.className = 's-badge'
    sp.textContent = cfg.label; sp.style.cssText = `background:${cfg.bg};color:${cfg.color}`
    wrap.appendChild(sp); td.appendChild(wrap)
  } else {
    const disp = document.createElement('div')
    disp.className   = 'cell-disp'
    disp.textContent = dispVal(col, row[col.key])
    td.appendChild(disp)
    td.addEventListener('mousedown', e => { e.preventDefault(); activateCell(ri, ci) })
  }
  return td
}

function dispVal(col, val) {
  if (!val) return ''
  if (col.type === 'sel')  return (col.opts.find(([v]) => v === val)||[])[1] || val
  if (col.type === 'date') return formatDate(val)
  return val
}

function rowKey(row) { return String(row.id || row._tid) }

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortAndRebuild() {
  // Linhas com data ordenadas cronologicamente; sem data vão pro final
  rows.sort((a, b) => {
    if (!a.date && !b.date) return 0
    if (!a.date) return 1
    if (!b.date) return -1
    return a.date.localeCompare(b.date)
  })
  buildTbody()
  renderCal()
}

// ── Ativação de célula ────────────────────────────────────────────────────────
function activateCell(ri, ci) {
  // Fecha célula anterior se for diferente
  if (active && (active.ri !== ri || active.ci !== ci)) {
    closeCell(active.ri, active.ci)
  }

  const col = COLS[ci]
  if (!col || col.type === 'badge') return

  active    = { ri, ci }
  activeKey = rowKey(rows[ri])

  // Destaca linha ativa
  document.querySelectorAll('.sheet-row').forEach(tr => tr.classList.remove('row-active'))
  getTr(ri)?.classList.add('row-active')

  // Cria editor
  const td = getTd(ri, ci); if (!td) return
  td.innerHTML = ''
  let ed

  if (col.type === 'sel') {
    ed = document.createElement('select'); ed.className = 'cell-ed'
    col.opts.forEach(([v,l]) => {
      const o = document.createElement('option'); o.value=v; o.textContent=l
      if (rows[ri][col.key] === v) o.selected = true
      ed.appendChild(o)
    })
    ed.addEventListener('change', () => { rows[ri][col.key] = ed.value; markDirty(ri); renderCal() })

  } else if (col.type === 'date') {
    ed = document.createElement('input'); ed.type = 'date'; ed.className = 'cell-ed'
    ed.value = rows[ri][col.key] || ''
    ed.addEventListener('change', () => { rows[ri][col.key] = ed.value; markDirty(ri) })
    // Navega o calendário para o mês desta data
    const ds = rows[ri][col.key]
    if (ds) { const [y,m] = ds.split('-'); calDate = new Date(+y,+m-1,1) }
    else    { calDate = new Date(); calDate.setDate(1) }

  } else {
    ed = document.createElement('input'); ed.type = 'text'; ed.className = 'cell-ed'
    ed.value = rows[ri][col.key] || ''
    ed.addEventListener('input', () => { rows[ri][col.key] = ed.value; markDirty(ri) })
  }

  ed.addEventListener('keydown', e => handleKey(e, ri, ci))
  ed.addEventListener('blur', () => setTimeout(() => {
    if (active?.ri === ri && active?.ci === ci) closeCell(ri, ci, true)
  }, 100))

  td.appendChild(ed)
  ed.focus()
  if (ed.type === 'text' && ed.select) ed.select()

  renderCal()
}

// Fecha o editor da célula e opcionalmente dispara sort se for data
function closeCell(ri, ci, triggerSort = false) {
  if (!active || active.ri !== ri || active.ci !== ci) return
  const isDate = COLS[ci].type === 'date'
  active = null

  const td = getTd(ri, ci); if (!td) return
  const col = COLS[ci]
  td.innerHTML = ''
  const disp = document.createElement('div'); disp.className = 'cell-disp'
  disp.textContent = dispVal(col, rows[ri][col.key])
  td.appendChild(disp)
  // Não re-adiciona mousedown — o listener original do buildTd continua ativo no td

  if (isDate && triggerSort) sortAndRebuild()
  else renderCal()
}

// Fecha o editor da célula sem reabrir (esc) — sem re-adicionar listener
function handleKey(e, ri, ci) {
  const col = COLS[ci]

  if (e.key === 'Escape') {
    e.preventDefault()
    active = null; activeKey = null
    const td = getTd(ri, ci); if (!td) return
    td.innerHTML = ''
    const disp = document.createElement('div'); disp.className = 'cell-disp'
    disp.textContent = dispVal(col, rows[ri][col.key])
    td.appendChild(disp)
    // Não re-adiciona mousedown — listener original do buildTd está ativo
    renderCal()
    return
  }

  if (e.key === 'Tab') {
    e.preventDefault()
    const nextCi = e.shiftKey ? prevEC(ci) : nextEC(ci)
    closeCell(ri, ci, false)   // fecha sem sort
    if (nextCi !== null) {
      activateCell(ri, nextCi)
    } else {
      // Fim da linha: sort se veio de data, depois abre próxima linha
      if (col.type === 'date') sortAndRebuild()
      const nextRi = e.shiftKey ? ri - 1 : ri + 1
      if (nextRi >= 0 && nextRi < rows.length) {
        const wrapCi = e.shiftKey ? EDITABLE_CI[EDITABLE_CI.length-1] : EDITABLE_CI[0]
        activateCell(nextRi, wrapCi)
      }
    }
    return
  }

  if (e.key === 'Enter') {
    e.preventDefault()
    closeCell(ri, ci, col.type === 'date')   // sort só se era data
    const nextRi = e.shiftKey ? ri - 1 : ri + 1
    if (nextRi >= 0 && nextRi < rows.length) {
      // Após sort, o nextRi pode ter mudado — acha pela posição relativa
      const targetRi = col.type === 'date'
        ? rows.findIndex((_, idx) => idx === nextRi)  // índice já correto após rebuild
        : nextRi
      if (targetRi >= 0) activateCell(targetRi, ci)
    }
    return
  }

  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && col.type !== 'text') {
    e.preventDefault()
    closeCell(ri, ci, col.type === 'date')
    const nri = e.key === 'ArrowUp' ? ri-1 : ri+1
    if (nri >= 0 && nri < rows.length) activateCell(nri, ci)
  }
}

function nextEC(ci) { const i = EDITABLE_CI.indexOf(ci); return i < EDITABLE_CI.length-1 ? EDITABLE_CI[i+1] : null }
function prevEC(ci) { const i = EDITABLE_CI.indexOf(ci); return i > 0 ? EDITABLE_CI[i-1] : null }
function getTd(ri,ci) { return $tbody.querySelector(`tr[data-ri="${ri}"] td[data-ci="${ci}"]`) }
function getTr(ri)    { return $tbody.querySelector(`tr[data-ri="${ri}"]`) }

// ── Dirty / Save ──────────────────────────────────────────────────────────────
function markDirty(ri) {
  dirty.add(rowKey(rows[ri]))
  getTr(ri)?.classList.add('row-dirty')
  updateSaveBtn()
}

function updateSaveBtn() {
  const n = dirty.size
  $save.disabled    = n === 0
  $save.textContent = n ? `Salvar (${n})` : 'Salvar'
  $ind.textContent  = n ? `${n} não salva${n===1?'':'s'}` : ''
}

async function saveAll() {
  if (!dirty.size) return
  if (active) closeCell(active.ri, active.ci, true)
  $save.disabled = true; $save.textContent = 'Salvando…'

  const errs = []
  for (const key of [...dirty]) {
    const ri  = rows.findIndex(r => rowKey(r) === key)
    if (ri < 0) continue
    const row = rows[ri]
    const payload = {
      date: row.date, newsletter: row.newsletter, format: row.format,
      campaign_name: row.campaign_name||'', authorship: row.authorship||'',
      isbn: row.isbn||'', suggested_text: row.suggested_text||'-',
      extra_info: row.extra_info||'', promotional_period: row.promotional_period||'',
      cover_link: row.cover_link||'', redirect_link: row.redirect_link||'',
    }
    try {
      if (row.id) {
        await updateBooking(row.id, payload)
      } else {
        const created = await createBooking({ ...payload, client_id: clientId, status: 'rascunho' })
        row.id = created.id; delete row._tid
        allBookings.push({ ...row })
      }
      getTr(ri)?.classList.remove('row-dirty')
    } catch(e) { errs.push(`${row.date||'?'}: ${e.message}`) }
  }

  dirty.clear()
  updateSaveBtn()
  renderCal()
  errs.length ? toast('Erros: '+errs.join(' | '),'err') : toast('Salvo!','ok')
}

// ── Adicionar / Excluir ───────────────────────────────────────────────────────
function addRow() {
  if (active) closeCell(active.ri, active.ci, false)
  newCnt++
  const row = {
    _tid: `new-${newCnt}`, client_id: clientId,
    date:'', newsletter:'aurora', format:'destaque', status:'rascunho',
    campaign_name:'', authorship:'', isbn:'', suggested_text:'',
    extra_info:'', promotional_period:'', cover_link:'', redirect_link:'',
  }
  rows.push(row)
  dirty.add(rowKey(row))
  updateSaveBtn()
  const ri = rows.length - 1
  $tbody.appendChild(buildTr(row, ri))
  activateCell(ri, DATE_CI)
}

async function deleteRow(ri) {
  if (!confirm('Excluir esta linha?')) return
  const row = rows[ri]
  if (row.id) {
    try { await deleteBooking(row.id) }
    catch(e) { toast('Erro ao excluir: '+e.message,'err'); return }
    allBookings = allBookings.filter(b => b.id !== row.id)
  }
  if (active?.ri === ri) { active = null; activeKey = null }
  rows.splice(ri, 1)
  dirty.delete(rowKey(row))
  buildTbody()
  updateSaveBtn()
  renderCal()
}

// ── Calendário ────────────────────────────────────────────────────────────────
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

function renderCal() {
  const y = calDate.getFullYear(), m = calDate.getMonth()
  $calTtl.textContent = `${MESES[m]} ${y}`

  // Linha ativa (pelo key, sobrevive ao sort)
  const ri     = activeKey ? rows.findIndex(r => rowKey(r) === activeKey) : -1
  const aRow   = ri >= 0 ? rows[ri] : null
  const aNL    = aRow?.newsletter || null
  const aFmt   = aRow?.format     || null
  const others = allBookings.filter(b => b.client_id !== clientId)
  const myDates= new Set(rows.map(r=>r.date).filter(Boolean))
  const today  = toISODate(new Date())

  $grid.innerHTML = ''
  ;['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].forEach(d => {
    const h = document.createElement('div'); h.className='cal-wd'; h.textContent=d; $grid.appendChild(h)
  })

  const fdow   = new Date(y,m,1).getDay()
  const offset = fdow === 0 ? 6 : fdow-1
  for (let i=0; i<offset; i++) { const e=document.createElement('div'); e.className='cal-d'; $grid.appendChild(e) }

  const days = new Date(y,m+1,0).getDate()
  for (let d=1; d<=days; d++) {
    const ds  = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const dow = new Date(ds+'T12:00:00').getDay()
    const isBlk = dow===0||dow===6 || FERIADOS_BR.includes(ds) || blocked.some(b=>b.date===ds)
    const taken = !isBlk && aNL && aFmt && !isSlotFree(ds, aNL, aFmt, others)
    const el = document.createElement('div')
    el.textContent = d; el.className = 'cal-d'

    if (isBlk)      el.classList.add('blocked')
    else if (taken) el.classList.add('taken')
    else if (aRow)  el.classList.add('free')

    if (myDates.has(ds))  el.classList.add('own')
    if (ds === today)     el.classList.add('today')
    if (aRow?.date === ds) el.classList.add('sel')

    if (!isBlk) {
      el.classList.add('clickable')
      el.addEventListener('click', () => setDate(ds))
    }
    $grid.appendChild(el)
  }

  // Hint contextual
  if (aRow) {
    const nlLabel  = NEWSLETTERS[aNL]?.label  || ''
    const fmtLabel = FORMATS[aFmt]?.label     || ''
    $calHint.innerHTML = `<strong>Clique para selecionar a data</strong><br>${nlLabel} · ${fmtLabel}`
  } else {
    $calHint.textContent = 'Selecione uma linha para usar o calendário'
  }
}

// Seta data na linha ativa via clique no calendário
function setDate(ds) {
  if (!activeKey) return

  const ri = rows.findIndex(r => rowKey(r) === activeKey)
  if (ri < 0) return

  rows[ri].date = ds
  markDirty(ri)

  // Atualiza o input se o editor de data estiver aberto
  if (active?.ri === ri && COLS[active.ci].type === 'date') {
    const ed = getTd(ri, active.ci)?.querySelector('.cell-ed')
    if (ed) ed.value = ds
    // Fecha o editor e faz sort
    closeCell(ri, active.ci, false)
  } else {
    // Atualiza display diretamente na célula de data
    const dateTd = getTd(ri, DATE_CI)
    if (dateTd) {
      dateTd.innerHTML = ''
      const disp = document.createElement('div'); disp.className = 'cell-disp'
      disp.textContent = formatDate(ds)
      dateTd.appendChild(disp)
      // Não re-adiciona mousedown — sortAndRebuild() logo abaixo reconstrói o tbody
    }
  }

  // Sort e re-render
  sortAndRebuild()
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _tt
function toast(msg, type='info') {
  $toast.textContent = msg; $toast.className = `toast ${type} show`
  clearTimeout(_tt); _tt = setTimeout(() => $toast.classList.remove('show'), 3000)
}

init()
