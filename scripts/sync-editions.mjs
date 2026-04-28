// scripts/sync-editions.mjs
// Sincroniza spots da ad_bookings com edições enviadas no GetResponse.
// Roda diariamente via .github/workflows/sync-editions.yml às 9h BRT.
//
// Lógica:
//   1. Busca bookings de hoje no Directus (status != rejeitado, published_link vazio, campaign_name preenchido)
//   2. Busca newsletters enviadas hoje no GetResponse
//   3. Pra cada booking, procura o título (campaign_name) no HTML da edição correspondente (Aurora ou Índice)
//   4. Se achar, escreve o link da edição no published_link

const DIRECTUS_URL = 'https://directus-production-afdd.up.railway.app'
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY

if (!DIRECTUS_TOKEN) { console.error('ERRO: DIRECTUS_TOKEN não definido'); process.exit(1) }
if (!GETRESPONSE_API_KEY) { console.error('ERRO: GETRESPONSE_API_KEY não definido'); process.exit(1) }

// ── Helpers ──────────────────────────────────────────────────────────────────

// Data de hoje no fuso BRT (UTC-3)
function todayBRT() {
  const now = new Date()
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000)
  const y = brt.getUTCFullYear()
  const m = String(brt.getUTCMonth() + 1).padStart(2, '0')
  const d = String(brt.getUTCDate()).padStart(2, '0')
  return { iso: `${y}-${m}-${d}`, br: `${d}/${m}/${y}` }
}

// Normaliza string pra match: lowercase + sem acentos + sem espaços extras
function norm(s) {
  if (!s) return ''
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

async function dx(path, opts = {}) {
  const res = await fetch(`${DIRECTUS_URL}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${DIRECTUS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`Directus ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function gr(path) {
  const res = await fetch(`https://api.getresponse.com/v3${path}`, {
    headers: {
      'X-Auth-Token': `api-key ${GETRESPONSE_API_KEY}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) throw new Error(`GetResponse ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = todayBRT()
  console.log(`\n═══ Sync editions — ${today.br} (${today.iso}) ═══\n`)

  // 1. Bookings de hoje sem published_link
  const filter = encodeURIComponent(JSON.stringify({
    _and: [
      { date: { _eq: today.iso } },
      { status: { _neq: 'rejeitado' } },
      { _or: [{ published_link: { _null: true } }, { published_link: { _eq: '' } }] },
      { campaign_name: { _nnull: true } },
      { campaign_name: { _neq: '' } },
    ],
  }))
  const bookingsRes = await dx(`/items/ad_bookings?filter=${filter}&limit=-1`)
  const bookings = bookingsRes.data || []
  console.log(`Bookings pendentes hoje: ${bookings.length}`)
  if (!bookings.length) { console.log('Nada a sincronizar. Encerrando.'); return }

  // 2. Newsletters enviadas hoje
  const newsletters = await gr(`/newsletters?query[sentOnFrom]=${today.iso}&query[sentOnTo]=${today.iso}&perPage=100`)
  console.log(`Newsletters enviadas hoje: ${newsletters.length}`)

  // Loga shape do primeiro objeto pra debug (nome dos campos da URL pública)
  if (newsletters[0]) {
    console.log('\n[debug] estrutura da primeira newsletter:')
    console.log(JSON.stringify(newsletters[0], null, 2).slice(0, 2000))
    console.log('...\n')
  }

  // Mapeia por tipo (aurora/indice)
  const byType = { aurora: null, indice: null }
  for (const nl of newsletters) {
    const n = norm(nl.subject || nl.name || '')
    if (n.includes('aurora')) byType.aurora = nl
    else if (n.includes('indice')) byType.indice = nl
  }
  console.log(`Aurora: ${byType.aurora ? byType.aurora.subject || byType.aurora.name : 'não encontrada'}`)
  console.log(`Índice: ${byType.indice ? byType.indice.subject || byType.indice.name : 'não encontrada'}`)

  // 3. Pra cada newsletter encontrada, busca o conteúdo HTML (sem isso, não tem como matchar)
  const contents = {}
  for (const [type, nl] of Object.entries(byType)) {
    if (!nl) continue
    try {
      const full = await gr(`/newsletters/${nl.newsletterId || nl.id}`)
      contents[type] = {
        html: norm(full.content?.html || full.content?.plain || ''),
        url: full.href || full.previewUrl || full.webView || full.content?.href || null,
        meta: full,
      }
      // Loga o objeto completo da primeira newsletter pra debug
      if (Object.keys(contents).length === 1) {
        console.log(`\n[debug] objeto completo da newsletter ${type}:`)
        console.log(JSON.stringify(full, null, 2).slice(0, 3000))
        console.log('...\n')
      }
    } catch (e) {
      console.log(`Erro ao buscar conteúdo da ${type}: ${e.message}`)
    }
  }

  // 4. Match e update
  let updated = 0, skipped = 0
  for (const b of bookings) {
    const type = b.newsletter // 'aurora' ou 'indice'
    const content = contents[type]
    if (!content) {
      console.log(`  · booking #${b.id} (${b.campaign_name}) — newsletter ${type} não foi enviada hoje, pulando`)
      skipped++
      continue
    }
    const titleNorm = norm(b.campaign_name)
    if (!titleNorm || titleNorm.length < 3) { skipped++; continue }
    if (content.html.includes(titleNorm)) {
      const url = content.url
      if (!url) {
        console.log(`  · booking #${b.id} (${b.campaign_name}) — match no HTML mas sem URL pública na resposta da API`)
        skipped++
        continue
      }
      try {
        await dx(`/items/ad_bookings/${b.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ published_link: url }),
        })
        console.log(`  ✓ booking #${b.id} (${b.campaign_name}) → ${url}`)
        updated++
      } catch (e) {
        console.log(`  ✗ booking #${b.id} (${b.campaign_name}) — erro ao atualizar: ${e.message}`)
        skipped++
      }
    } else {
      console.log(`  · booking #${b.id} (${b.campaign_name}) — não encontrado no HTML da ${type}`)
      skipped++
    }
  }

  console.log(`\n═══ Resumo: ${updated} atualizados, ${skipped} pulados ═══\n`)
}

main().catch(e => {
  console.error('Erro fatal:', e)
  process.exit(1)
})
