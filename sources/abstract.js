// Clase base mínima para que nyaa.js funcione por sí sola.
// Es un reemplazo sencillo: si Shiru se queja de esta clase, sustitúyela por el
// abstract.js original de la extensión de referencia (gh:RockinChaos/Shiru/extensions).
export default class AbstractSource {
  url = ''

  async single () { return [] }
  async batch () { return [] }
  async movie () { return [] }
  async validate () { return true }
}
