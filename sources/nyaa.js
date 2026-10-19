// Verificador de resultados: decide si el título de un release corresponde
// exactamente al anime, temporada y episodio que pidió Shiru.
// Regla general: ante la duda se descarta (mejor menos resultados que mezclados).

const EXT = /\.(mkv|mp4|avi|ts|m2ts)$/i

// Minúsculas, sin acentos ni apóstrofes, solo letras y números separados por espacios.
export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const SEASON_RES = [/\bseason (\d{1,2})\b/, /\b(\d{1,2})(?:st|nd|rd|th) season\b/, /\bs(\d{1,2})\b/]

// "frieren 2nd season" -> { base: "frieren", season: 2 }
export const splitSeason = (n) => {
  for (const re of SEASON_RES) {
    const m = n.match(re)
    if (m) return { base: n.replace(re, ' ').replace(/\s+/g, ' ').trim(), season: Number(m[1]) }
  }
  return { base: n, season: undefined }
}

// Títulos conocidos del anime (Shiru + AniList), normalizados y sin duplicados.
export function buildKnown (options = {}) {
  const t = options.media?.title || {}
  const raw = [...(options.titles || []), t.romaji, t.english, t.native, ...(options.media?.synonyms || [])]
  const seen = new Set()
  const out = []
  for (const r of raw) {
    const full = norm(r)
    if (full.length < 3 || seen.has(full)) continue
    seen.add(full)
    out.push({ full, ...splitSeason(full) })
  }
  return out
}

// Lee el título de un release: nombre, temporada, episodio o rango.
export function parseRelease (title) {
  const t = String(title ?? '').replace(EXT, '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim()

  // Se quitan datos técnicos (resolución, códecs, hash, año) para no confundirlos con el episodio.
  const body = t
    .replace(/[\[(](?:19|20)\d{2}[\])]/g, ' ')
    .replace(/\[[0-9a-f]{8}\]/gi, ' ')
    .replace(/\b\d{3,4}p\b/gi, ' ')
    .replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ')
    .replace(/\b[xh]\.?26[45]\b/gi, ' ')
    .replace(/\b(?:aac|ddp?|eac3|ac3|flac|opus)\s?\d(?:\.\d)?\b/gi, ' ')
    .replace(/\b\d{1,2}\s?bit\b/gi, ' ')
    .replace(/\b\d\.\d\b/g, ' ')

  let season, episode, range
  let cut = body.length
  const find = (re) => {
    const m = body.match(re)
    if (m && m.index < cut) cut = m.index
    return m
  }

  let m
  if ((m = find(/(?<![\d.])(\d{1,4})(?:-|~)(\d{1,4})(?![\d.])/)) && Number(m[2]) > Number(m[1])) {
    range = [Number(m[1]), Number(m[2])]
  } else if ((m = find(/\bS(\d{1,2})\s?E(\d{1,4})(?:v\d)?\b/i))) {
    season = Number(m[1]); episode = Number(m[2])
  } else if ((m = find(/\b(\d{1,2})x(\d{1,3})\b/i))) {
    season = Number(m[1]); episode = Number(m[2])
  } else if ((m = find(/\b(?:episode|ep)\.?\s?(\d{1,4})(?:v\d)?\b|\bE(\d{1,4})(?:v\d)?\b/i))) {
    episode = Number(m[1] ?? m[2])
  } else if ((m = find(/(?:^|\s)-\s(\d{1,4})(?:v\d)?(?=\s|$|\[|\()/))) {
    episode = Number(m[1])
  }

  // Nombre = texto antes del episodio y antes del primer corchete o paréntesis.
  let head = body.slice(0, cut)
  head = head.split(/[\[(]/)[0]
  const names = head.split(/\s[|\/]\s/).map(norm).filter(Boolean).map(full => ({ full, ...splitSeason(full) }))

  return {
    names,
    season: season ?? names.find(n => n.season !== undefined)?.season,
    episode,
    range,
    batch: /\b(batch|complete|completa|collection)\b/i.test(t)
  }
}

// ¿Este release es exactamente lo que se pidió?
//   mode: 'single' | 'batch' | 'movie'
//   strict: si es true, sin marcador de temporada en una secuela solo se acepta numeración absoluta.
export function acceptRelease (rel, options, mode, known = buildKnown(options), strict = true) {
  const num = (v) => Number.isFinite(v)
  const abs = options.absoluteEpisode
  const wanted = [options.episode, abs].filter(num)
  const oneShot = options.media?.episodes === 1 || options.episodeCount === 1 || options.media?.format === 'MOVIE'

  // Candidatos de lectura. Si el título no marca el episodio ("One Piece 1180"), también se
  // prueba el número final como episodio, solo si tiene 2 o más cifras (un "2" suelto
  // suele ser una secuela: "Boku no Hero Academia 2").
  const cands = []
  for (const n of rel.names) {
    cands.push({ n, episode: rel.episode })
    const tail = rel.episode == null && !rel.range && n.full.match(/^(.+?) (\d{2,4})$/)
    if (tail) cands.push({ n: { full: tail[1], ...splitSeason(tail[1]) }, episode: Number(tail[2]) })
  }

  for (const { n, episode } of cands) {
    for (const k of known) {
      const exact = n.full === k.full
      if (!exact && n.base !== k.base) continue // otro anime (p. ej. "One Piece Heroines")

      const ks = k.season ?? options.season ?? 1 // temporada que se busca
      const rs = rel.season // temporada que dice el release
      if (rs === 0 && options.season !== 0) continue // especiales
      if (rs !== undefined && rs !== ks && !(exact && rel.season === n.season)) continue // otra temporada

      // Secuela sin marcador de temporada: solo se puede verificar con numeración absoluta.
      const needsAbs = strict && !exact && rs === undefined && ks > 1

      if (mode === 'movie') {
        if (rel.range || (episode != null && !oneShot)) continue
        return true
      }

      if (mode === 'batch') {
        if (episode != null) continue
        if (rel.range) {
          const check = needsAbs ? [abs].filter(num) : wanted
          if (check.length && !check.some(w => w >= rel.range[0] && w <= rel.range[1])) continue
        } else if (needsAbs) continue
        return true
      }

      // single
      if (rel.range) continue
      if (episode == null) {
        if (!oneShot) continue
        return true
      }
      let ok
      if (needsAbs) ok = num(abs) && abs !== options.episode && episode === abs
      else if (rs !== undefined) ok = episode === options.episode || (ks === 1 && episode === abs)
      else ok = wanted.includes(episode)
      if (ok) return true
    }
  }
  return false
}
