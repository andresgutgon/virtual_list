export function get_container_height(id) {
  const el = document.getElementById(id)
  if (el && el.clientHeight > 0) return el.clientHeight
  return window.innerHeight
}
