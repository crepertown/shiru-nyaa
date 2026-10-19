import AbstractSource from './abstract.js'
import { acceptRelease, buildKnown, norm, parseRelease } from './match.js'

// Trackers añadidos al magnet generado a partir del infoHash.
const TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stat.eu:1337/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
]

const UNITS = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')

// Extrae el contenido de una etiqueta del XML (sin DOMParser: en un Web Worker no existe).
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  if (!m) return ''
  return decode(m[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1'))
}

const toBytes = (str) => {
  const m = str.match(/([\d.]+)\s*([KMGT]?i?B)/i)
  return m ? Math.round(parseFloat(m[1]) * (UNITS[m[2].toLowerCase()] || 1)) : 0
}

// Quita caracteres que rompen la sintaxis de búsqueda de Nyaa.
const clean = (s) => String(s ?? '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()

export default new class Nyaa extends AbstractSource {
  url = 'https://nyaa.si'
  category = '1_0' // Todo el anime. ('1_2' = solo inglés, '1_3' = otros idiomas, '1_4' = raws)

  // Palabras que indican subtítulos en español o varios idiomas: esos resultados salen primero.
  // Déjalo vacío ([]) para desactivar el orden por idioma.
  languages = ['spanish', 'spa', 'esp', 'latino', 'castellano', 'multi', 'multisub', 'multisubs', 'multiple']

  // true: una secuela sin marcador de temporada solo se acepta con numeración absoluta.
  // false: más resultados, pero pueden colarse episodios de otra temporada.
  strictSeasons = true

  maxTitles = 4 // títulos distintos usados en la búsqueda

  _langWords () { return this.languages.map(clean).filter(Boolean) }

  _isLang (title) {
    const w = this._langWords()
    return w.length ? new RegExp(`\\b(${w.join('|')})\\b`, 'i').test(title) : false
  }

  // Títulos para la búsqueda: sin duplicados y sin los muy cortos (traen resultados de otros animes).
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

  _exclusions (exclusions = []) {
    return exclusions.map(e => `-${clean(e).replace(/\s+/g, '')}`).filter(e => e.length > 1).join(' ')
  }

  async _search (query) {
    const res = await fetch(
      `${this.url}/?page=rss&q=${encodeURIComponent(query)}&c=${this.category}&f=0&s=seeders&o=desc`
    )
    if (!res?.ok) return []

    const xml = await res.text()
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || []
    const trackers = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('')

    return items.map(item => {
      const title = tag(item, 'title')
      const hash = tag(item, 'nyaa:infoHash').toLowerCase()
      return {
        title,
        link: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`,
        id: Number((tag(item, 'guid').match(/view\/(\d+)/) || [])[1]) || undefined,
        seeders: Number(tag(item, 'nyaa:seeders')) || 0,
        leechers: Number(tag(item, 'nyaa:leechers')) || 0,
        downloads: Number(tag(item, 'nyaa:downloads')) || 0,
        accuracy: 'medium',
        hash,
        size: toBytes(tag(item, 'nyaa:size')),
        date: new Date(tag(item, 'pubDate')),
        raw: tag(item, 'nyaa:categoryId') === '1_4'
      }
    }).filter(r => r.hash)
  }

  // Busca, comprueba cada título (anime, temporada, episodio) y ordena.
  async _find (options, mode, ep) {
    const titles = this._queryTitles(options)
    if (!titles.length) return []
    const known = buildKnown(options)
    const q = `(${titles.map(t => `"${t}"`).join('|')})`
    const words = this._langWords()
    const lang = words.length ? `(${words.join('|')})` : ''
    const excl = this._exclusions(options.exclusions)
    const res = options.resolution
    const batchWords = mode === 'batch' ? '(batch|complete)' : ''

    // Primero con la resolución pedida; si no queda nada válido, sin ella.
    for (const r of (res ? [res, ''] : [''])) {
      const base = [q, ep, r, excl]
      const queries = [base]
      if (lang) queries.push([q, ep, lang, r, excl])
      if (mode === 'batch' && !ep) queries.push([q, batchWords, r, excl])

      const lists = await Promise.all(
        queries.map(parts => this._search(parts.filter(Boolean).join(' ')).catch(() => []))
      )
      const unique = new Map()
      for (const x of lists.flat()) if (!unique.has(x.hash)) unique.set(x.hash, x)

      const valid = [...unique.values()].filter(x =>
        acceptRelease(parseRelease(x.title), options, mode, known, this.strictSeasons))
      if (!valid.length) continue

      return valid
        .map(x => ({ x, es: this._isLang(x.title), res: !!r && x.title.includes(r) }))
        // 1) con idioma, 2) no raws, 3) resolución pedida, 4) más semillas
        .sort((a, b) => (b.es - a.es) || (a.x.raw - b.x.raw) || (b.res - a.res) || (b.x.seeders - a.x.seeders))
        .map(({ x, es }) => {
          const { raw, ...result } = x
          return { ...result, type: mode === 'batch' ? 'batch' : (es ? 'best' : 'alt') }
        })
    }
    return []
  }

  async single (options) {
    // El episodio se rellena a 2 cifras, o a tantas como tenga la serie (p. ej. 3 para 100+ episodios).
    const width = Math.max(2, String(options.episodeCount || '').length)
    const ep = options.episode != null ? String(options.episode).padStart(width, '0') : ''
    return this._find(options, 'single', ep)
  }

  async batch (options) {
    return this._find(options, 'batch', '')
  }

  async movie (options) {
    return this._find(options, 'movie', '')
  }

  async validate () {
    try {
      return (await fetch(`${this.url}/?page=rss&q=test&c=${this.category}`))?.ok === true
    } catch {
      return false
    }
  }
}()
