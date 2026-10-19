import AbstractSource from './abstract.js'

// Trackers añadidos al magnet generado a partir del infoHash.
const TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stat.eu:1337/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce'
]

const UNITS = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }

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

// "1.4 GiB" -> bytes
const toBytes = (str) => {
  const m = str.match(/([\d.]+)\s*([KMGT]?i?B)/i)
  return m ? Math.round(parseFloat(m[1]) * (UNITS[m[2].toLowerCase()] || 1)) : 0
}

// Quita caracteres que rompen la sintaxis de búsqueda de Nyaa.
const clean = (s) => String(s ?? '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()

export default new class Nyaa extends AbstractSource {
  url = 'https://nyaa.si'
  category = '1_0' // Todo el anime. ('1_2' = solo inglés, '1_3' = otros idiomas, '1_4' = raws)

  // Palabras que indican subtítulos en español. Los resultados cuyo título las
  // contiene se muestran primero (no se descartan los demás).
  // Déjalo vacío ([]) para desactivar el orden por idioma.
  languages = ['spanish', 'spa', 'esp', 'latino', 'castellano', 'multi', 'multisub', 'multisubs', 'multiple']

  _lang () {
    const words = this.languages.map(clean).filter(Boolean)
    return words.length ? `(${words.join('|')})` : ''
  }

  _isLang (title) {
    const words = this.languages.map(clean).filter(Boolean)
    return words.length ? new RegExp(`\\b(${words.join('|')})\\b`, 'i').test(title) : false
  }

  // Títulos de Shiru + títulos y sinónimos de AniList (a veces incluyen el título en español).
  _titleList ({ titles = [], media } = {}) {
    const t = media?.title || {}
    const all = [...titles, t.romaji, t.english, ...(media?.synonyms || [])]
    return [...new Set(all.map(clean).filter(Boolean))].slice(0, 10)
  }

  _exclusions (exclusions = []) {
    return exclusions.map(e => `-${clean(e).replace(/\s+/g, '')}`).filter(e => e.length > 1).join(' ')
  }

  async _search (query, type) {
    const res = await fetch(
      `${this.url}/?page=rss&q=${encodeURIComponent(query)}&c=${this.category}&f=0&s=seeders&o=desc`
    )
    if (!res?.ok) return []

    const xml = await res.text()
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || []

    return items.map(item => {
      const title = tag(item, 'title')
      const hash = tag(item, 'nyaa:infoHash').toLowerCase()
      const id = Number((tag(item, 'guid').match(/view\/(\d+)/) || [])[1]) || undefined
      const trackers = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('')

      return {
        title,
        link: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`,
        id,
        seeders: Number(tag(item, 'nyaa:seeders')) || 0,
        leechers: Number(tag(item, 'nyaa:leechers')) || 0,
        downloads: Number(tag(item, 'nyaa:downloads')) || 0,
        accuracy: 'medium',
        hash,
        size: toBytes(tag(item, 'nyaa:size')),
        date: new Date(tag(item, 'pubDate')),
        type
      }
    }).filter(r => r.hash)
  }

  // Hace una búsqueda general y otra con palabras de idioma, une los resultados
  // sin repetir y pone primero los que mencionan español.
  async _find (options, middle, type) {
    const titles = `(${this._titleList(options).map(t => `"${t}"`).join('|')})`
    const tail = [options.resolution, this._exclusions(options.exclusions)]
    const lang = this._lang()

    const queries = [[titles, ...middle, ...tail]]
    if (lang) queries.push([titles, ...middle, lang, ...tail])

    const lists = await Promise.all(
      queries.map(q => this._search(q.filter(Boolean).join(' '), type).catch(() => []))
    )

    const unique = new Map()
    for (const r of lists.flat()) if (!unique.has(r.hash)) unique.set(r.hash, r)

    return [...unique.values()]
      .map(r => ({ r, es: this._isLang(r.title) }))
      .sort((a, b) => (b.es - a.es) || (b.r.seeders - a.r.seeders))
      .map(({ r, es }) => ({ ...r, type: type === 'batch' ? 'batch' : (es ? 'best' : 'alt') }))
  }

  async single (options) {
    const ep = options.episode != null ? String(options.episode).padStart(2, '0') : ''
    return this._find(options, [ep], 'alt')
  }

  async batch (options) {
    return this._find(options, ['(batch|complete)'], 'batch')
  }

  async movie (options) {
    return this._find(options, [], 'alt')
  }

  async validate () {
    try {
      return (await fetch(`${this.url}/?page=rss&q=test&c=${this.category}`))?.ok === true
    } catch {
      return false
    }
  }
}()
