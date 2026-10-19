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
const clean = (s) => String(s).replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()

export default new class Nyaa extends AbstractSource {
  url = 'https://nyaa.si'
  category = '1_0' // Todo el anime. ('1_2' = solo inglés, '1_3' = otros idiomas, '1_4' = raws)

  // Palabras que debe tener el título para priorizar subs en español.
  // Déjalo vacío ([]) para desactivar el filtro de idioma.
  languages = ['spanish', 'spa', 'esp', 'latino', 'multi', 'multiple']

  _lang () {
    const words = this.languages.map(clean).filter(Boolean)
    return words.length ? `(${words.join('|')})` : ''
  }

  _titles (titles = []) {
    const unique = [...new Set(titles.map(clean).filter(Boolean))].slice(0, 6)
    return `(${unique.map(t => `"${t}"`).join('|')})`
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

  async single ({ titles, episode, resolution, exclusions }) {
    const ep = episode != null ? String(episode).padStart(2, '0') : ''
    const query = [this._titles(titles), ep, this._lang(), resolution, this._exclusions(exclusions)]
      .filter(Boolean).join(' ')
    return this._search(query, 'alt')
  }

  async batch ({ titles, resolution, exclusions }) {
    const query = [this._titles(titles), '(batch|complete)', this._lang(), resolution, this._exclusions(exclusions)]
      .filter(Boolean).join(' ')
    return this._search(query, 'batch')
  }

  async movie ({ titles, resolution, exclusions }) {
    const query = [this._titles(titles), this._lang(), resolution, this._exclusions(exclusions)]
      .filter(Boolean).join(' ')
    return this._search(query, 'alt')
  }

  async validate () {
    try {
      return (await fetch(`${this.url}/?page=rss&q=test&c=${this.category}`))?.ok === true
    } catch {
      return false
    }
  }
}()
