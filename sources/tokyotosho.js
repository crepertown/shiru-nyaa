import AbstractSource from './abstract.js'

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const decode = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&amp;/g, '&')

// Extrae el contenido de una etiqueta del XML (sin DOMParser: en un Web Worker no existe).
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  if (!m) return ''
  return decode(m[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'))
}

// Quita caracteres que rompen la sintaxis de búsqueda.
const clean = (s) => String(s ?? '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()

// "442.37MB" -> bytes (Tokyo Toshokan usa múltiplos de 1024)
const toBytes = (str) => {
  const m = str.match(/([\d.]+)\s*([KMGT]?B)/i)
  return m ? Math.round(parseFloat(m[1]) * (UNITS[m[2].toLowerCase()] || 1)) : 0
}

// Los magnets de Tokyo Toshokan traen el hash en base32 (32 caracteres);
// Shiru necesita el hash hexadecimal (40 caracteres).
const toHex = (h) => {
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase()
  if (!/^[A-Z2-7]{32}$/i.test(h)) return ''
  let bits = ''
  for (const c of h.toUpperCase()) bits += BASE32.indexOf(c).toString(2).padStart(5, '0')
  let hex = ''
  for (let i = 0; i < 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

export default new class TokyoToshokan extends AbstractSource {
  url = 'https://www.tokyotosho.info'

  // El feed mezcla categorías (incluido manga hentai), así que se filtra aquí.
  // Categorías de Tokyo Toshokan: anime, batch, non-english, raws, manga, drama, music...
  categories = ['anime', 'batch', 'non-english']

  // Palabras que indican subtítulos en español o varios idiomas. Los resultados
  // cuyo título las contiene se muestran primero. Déjalo vacío ([]) para desactivar.
  languages = ['spanish', 'spa', 'esp', 'latino', 'castellano', 'multi', 'multisub', 'multisubs', 'multiple']

  maxTitles = 4 // cuántos títulos distintos se buscan (una petición por título)

  _isLang (title) {
    const words = this.languages.map(clean).filter(Boolean)
    return words.length ? new RegExp(`\\b(${words.join('|')})\\b`, 'i').test(title) : false
  }

  // Títulos de Shiru + títulos y sinónimos de AniList (a veces incluyen el título en español).
  _titleList ({ titles = [], media } = {}) {
    const t = media?.title || {}
    const all = [...titles, t.romaji, t.english, ...(media?.synonyms || [])]
    return [...new Set(all.map(clean).filter(Boolean))].slice(0, this.maxTitles)
  }

  async _search (terms) {
    const res = await fetch(`${this.url}/rss.php?terms=${encodeURIComponent(terms)}`)
    if (!res?.ok) return []

    const xml = await res.text()
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || []

    return items.map(item => {
      const title = tag(item, 'title')
      const category = tag(item, 'category').toLowerCase()
      const desc = tag(item, 'description')
      const magnet = (desc.match(/magnet:\?[^"'\s<]+/) || [])[0] || ''
      const hash = toHex((magnet.match(/btih:([A-Za-z0-9]+)/i) || [])[1] || '')
      const id = Number((tag(item, 'guid').match(/id=(\d+)/) || [])[1]) || undefined

      return {
        title,
        category,
        link: magnet,
        id,
        // Este feed no publica semillas ni descargas.
        seeders: 0,
        leechers: 0,
        downloads: 0,
        accuracy: 'medium',
        hash,
        size: toBytes((desc.match(/Size:\s*([\d.]+\s*[KMGT]?B)/i) || [])[1] || ''),
        date: new Date(tag(item, 'pubDate'))
      }
    }).filter(r => r.hash && r.link && this.categories.includes(r.category))
  }

  async _find (options, middle, type) {
    const { resolution, exclusions = [] } = options
    const titles = this._titleList(options)

    const lists = await Promise.all(
      titles.map(t => this._search([t, ...middle].filter(Boolean).join(' ')).catch(() => []))
    )

    const isBatch = (r) => r.category === 'batch' || /batch|complete/i.test(r.title)
    const banned = exclusions.map(e => String(e).toLowerCase()).filter(Boolean)

    const unique = new Map()
    for (const r of lists.flat()) if (!unique.has(r.hash)) unique.set(r.hash, r)

    return [...unique.values()]
      .filter(r => (type === 'batch' ? isBatch(r) : !isBatch(r)))
      .filter(r => !banned.some(b => r.title.toLowerCase().includes(b)))
      .map((r, i) => ({ r, i, es: this._isLang(r.title), res: !!resolution && r.title.includes(resolution) }))
      // primero idioma, luego resolución, luego el orden del feed (más recientes antes)
      .sort((a, b) => (b.es - a.es) || (b.res - a.res) || (a.i - b.i))
      .map(({ r, es }) => {
        const { category, ...result } = r
        return { ...result, type: type === 'batch' ? 'batch' : (es ? 'best' : 'alt') }
      })
  }

  async single (options) {
    const ep = options.episode != null ? String(options.episode).padStart(2, '0') : ''
    return this._find(options, [ep], 'alt')
  }

  async batch (options) {
    return this._find(options, [], 'batch')
  }

  async movie (options) {
    return this._find(options, [], 'alt')
  }

  async validate () {
    try {
      return (await fetch(`${this.url}/rss.php?terms=test`))?.ok === true
    } catch {
      return false
    }
  }
}()
