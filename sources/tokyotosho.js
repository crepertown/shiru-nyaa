import AbstractSource from './abstract.js'
import { acceptRelease, buildKnown, norm, parseRelease } from './match.js'

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')

// Extrae el contenido de una etiqueta del XML (sin DOMParser: en un Web Worker no existe).
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  if (!m) return ''
  return decode(m[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'))
}

const clean = (s) => String(s ?? '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()

// "442.37MB" -> bytes
const toBytes = (str) => {
  const m = str.match(/([\d.]+)\s*([KMGT]?B)/i)
  return m ? Math.round(parseFloat(m[1]) * (UNITS[m[2].toLowerCase()] || 1)) : 0
}

// Los magnets de Tokyo Toshokan traen el hash en base32 (32 caracteres);
// Shiru necesita el hexadecimal (40 caracteres).
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
  categories = ['anime', 'batch', 'non-english']

  // Palabras que indican subtítulos en español o varios idiomas: esos resultados salen primero.
  // Déjalo vacío ([]) para desactivar el orden por idioma.
  languages = ['spanish', 'spa', 'esp', 'latino', 'castellano', 'multi', 'multisub', 'multisubs', 'multiple']

  // true: una secuela sin marcador de temporada solo se acepta con numeración absoluta.
  strictSeasons = true

  maxTitles = 4 // una petición por título

  _isLang (title) {
    const w = this.languages.map(clean).filter(Boolean)
    return w.length ? new RegExp(`\\b(${w.join('|')})\\b`, 'i').test(title) : false
  }

  // Títulos para la búsqueda: sin duplicados y sin los muy cortos.
  _queryTitles ({ titles = [], media } = {}) {
    const t = media?.title || {}
    const seen = new Set()
    const out = []
    for (const raw of [...titles, t.romaji, t.english, ...(media?.synonyms || [])]) {
      const c = clean(raw)
      const n = norm(c)
      if (n.length < 4 || seen.has(n)) continue
      seen.add(n)
      out.push(c)
    }
    return out.slice(0, this.maxTitles)
  }

  async _search (terms) {
    const res = await fetch(`${this.url}/rss.php?terms=${encodeURIComponent(terms)}`)
    if (!res?.ok) return []

    const xml = await res.text()
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || []

    return items.map(item => {
      const desc = tag(item, 'description')
      const magnet = (desc.match(/magnet:\?[^"'\s<]+/) || [])[0] || ''
      return {
        title: tag(item, 'title'),
        category: tag(item, 'category').toLowerCase(),
        link: magnet,
        id: Number((tag(item, 'guid').match(/id=(\d+)/) || [])[1]) || undefined,
        seeders: 0, // este feed no publica semillas ni descargas
        leechers: 0,
        downloads: 0,
        accuracy: 'medium',
        hash: toHex((magnet.match(/btih:([A-Za-z0-9]+)/i) || [])[1] || ''),
        size: toBytes((desc.match(/Size:\s*([\d.]+\s*[KMGT]?B)/i) || [])[1] || ''),
        date: new Date(tag(item, 'pubDate'))
      }
    }).filter(r => r.hash && r.link && this.categories.includes(r.category))
  }

  // Busca por cada título, comprueba anime, temporada y episodio, y ordena.
  async _find (options, mode, ep) {
    const titles = this._queryTitles(options)
    if (!titles.length) return []
    const known = buildKnown(options)
    const res = options.resolution

    const lists = await Promise.all(
      titles.map(t => this._search([t, ep].filter(Boolean).join(' ')).catch(() => []))
    )
    const unique = new Map()
    for (const r of lists.flat()) if (!unique.has(r.hash)) unique.set(r.hash, r)

    return [...unique.values()]
      .filter(r => acceptRelease(parseRelease(r.title), options, mode, known, this.strictSeasons))
      .map((r, i) => ({ r, i, es: this._isLang(r.title), res: !!res && r.title.includes(res) }))
      // idioma, luego resolución pedida, luego el orden del feed (más recientes primero)
      .sort((a, b) => (b.es - a.es) || (b.res - a.res) || (a.i - b.i))
      .map(({ r, es }) => {
        const { category, ...result } = r
        return { ...result, type: mode === 'batch' ? 'batch' : (es ? 'best' : 'alt') }
      })
  }

  async single (options) {
    const width = Math.max(2, String(options.episodeCount || '').length)
    const ep = options.episode != null ? String(options.episode).padStart(width, '0') : ''
    return this._find(options, 'single', ep)
  }

  async batch (options) { return this._find(options, 'batch', '') }

  async movie (options) { return this._find(options, 'movie', '') }

  async validate () {
    try {
      return (await fetch(`${this.url}/rss.php?terms=test`))?.ok === true
    } catch {
      return false
    }
  }
}()
