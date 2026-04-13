// setup-agenda.mjs
// Pré-preenche o Directus com slots semanais Rascunho até 31/12/2026
// para todos os clientes ativos que tenham cotas configuradas.
//
// Uso: node setup-agenda.mjs
// Ou para um cliente específico: node setup-agenda.mjs companhia

import { DIRECTUS_URL, SERVICE_TOKEN } from './config.js'

const BASE = DIRECTUS_URL
const HDR  = { 'Content-Type':'application/json', Authorization:`Bearer ${SERVICE_TOKEN}` }

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: HDR })
  const d = await r.json()
  if (!r.ok) throw new Error(d.errors?.[0]?.message || `GET ${path} → ${r.status}`)
  return d.data
}
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method:'POST', headers: HDR, body: JSON.stringify(body) })
  const d = await r.json()
  if (!r.ok) throw new Error(d.errors?.[0]?.message || `POST ${path} → ${r.status}`)
  return d.data
}

// ── Feriados ──────────────────────────────────────────────────────────────────
const FERIADOS = new Set([
  '2026-01-01','2026-02-16','2026-02-17','2026-04-03','2026-04-21',
  '2026-05-01','2026-06-04','2026-07-09','2026-09-07','2026-10-12',
  '2026-11-02','2026-11-15','2026-11-20','2026-12-25',
])

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function isBlocked(ds) {
  const dow = new Date(ds+'T12:00:00').getDay()
  return dow === 0 || dow === 6 || FERIADOS.has(ds)
}
function mondayOf(ds) {
  const d = new Date(ds+'T12:00:00')
  const dow = d.getDay()
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow))
  return isoDate(d)
}

// Slots que queremos garantir toda semana (newsletter + format)
const SLOTS = [
  { newsletter:'aurora', format:'destaque'  },
  { newsletter:'aurora', format:'corpo'     },
  { newsletter:'indice', format:'destaque'  },
]

// Dia preferido por slot (dia da semana JS: 1=seg...5=sex)
// Tentativa de dias em ordem de preferência
const PREF = {
  'aurora_destaque':  [3,4,2,5,1],   // qua, qui, ter, sex, seg
  'aurora_corpo':     [4,3,5,2,1],   // qui, qua, sex, ter, seg
  'indice_destaque':  [3,4,2,5,1],   // qua, qui, ter, sex, seg
}

function pickDay(weekMonday, slotKey, ocupados) {
  const pref = PREF[slotKey] || [3,4,2,5,1]
  const base = new Date(weekMonday+'T12:00:00')
  for (const dow of pref) {
    const d = new Date(base)
    d.setDate(d.getDate() + (dow - 1))   // base é segunda (1)
    const ds = isoDate(d)
    if (!isBlocked(ds) && !ocupados.has(ds+'_'+slotKey)) return ds
  }
  return null   // semana toda bloqueada (raro)
}

// ── Main ──────────────────────────────────────────────────────────────────────
const filtroCliente = process.argv[2]?.toLowerCase()

console.log('Buscando clientes…')
const clients = await get('/items/ad_clients?filter[active][_eq]=true&fields=id,company_name&limit=-1')
const target  = filtroCliente
  ? clients.filter(c => c.company_name.toLowerCase().includes(filtroCliente))
  : clients

if (!target.length) { console.log('Nenhum cliente encontrado.'); process.exit(0) }
console.log(`Clientes: ${target.map(c=>c.company_name).join(', ')}\n`)

const fim = new Date('2026-12-31T12:00:00')

for (const client of target) {
  console.log(`── ${client.company_name} (id=${client.id})`)

  // Busca bookings existentes
  const existing = await get(`/items/ad_bookings?filter[client_id][_eq]=${client.id}&fields=id,date,newsletter,format,status&limit=-1`)

  // Mapa de semanas cobertas por slot (sem Rascunho = cobertura real)
  const cobertura = {}  // semanaKey_slotKey → true
  const rascunhosExist = new Set()  // semanaKey_slotKey → tem rascunho
  const ocupadoGlobal  = new Set()  // date_slotKey (outros clientes)

  for (const b of existing) {
    const sk  = `${b.newsletter}_${b.format}`
    const sem = mondayOf(b.date)
    if (b.status !== 'rascunho') cobertura[`${sem}_${sk}`] = true
    else rascunhosExist.add(`${sem}_${sk}`)
  }

  // Datas já ocupadas por outros clientes (para não colidir)
  // (aqui só evitamos colidir no mesmo dia — opcional para não travar datas raras)

  // Semana inicial: semana atual
  let cur = new Date()
  const dow0 = cur.getDay()
  cur.setDate(cur.getDate() + (dow0===0 ? -6 : 1-dow0))
  cur.setHours(12,0,0,0)

  const novos = []

  while (cur <= fim) {
    const sem = isoDate(cur)

    for (const slot of SLOTS) {
      const sk  = `${slot.newsletter}_${slot.format}`
      const key = `${sem}_${sk}`

      // Já tem booking real nessa semana → não cria rascunho
      if (cobertura[key]) continue
      // Já tem rascunho nessa semana → mantém
      if (rascunhosExist.has(key)) continue

      const date = pickDay(sem, sk, ocupadoGlobal)
      if (!date) { console.log(`  ! semana ${sem} sem dia disponível para ${sk}`); continue }

      novos.push({ client_id: client.id, date, newsletter: slot.newsletter, format: slot.format, status: 'rascunho', campaign_name:'', suggested_text:'-' })
      ocupadoGlobal.add(`${date}_${sk}`)
    }

    cur.setDate(cur.getDate() + 7)
  }

  if (!novos.length) { console.log('  ✓ Sem linhas novas a criar\n'); continue }

  console.log(`  Criando ${novos.length} linhas Rascunho…`)
  // Cria em batches de 50
  for (let i=0; i<novos.length; i+=50) {
    await post('/items/ad_bookings', novos.slice(i,i+50))
  }
  console.log(`  ✓ ${novos.length} criadas\n`)
}

console.log('Concluído.')
