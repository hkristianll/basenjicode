export function createInput(target = window) {
  const held = new Set()
  target.addEventListener('keydown', (event) => held.add(event.key))
  target.addEventListener('keyup', (event) => held.delete(event.key))
  return {
    axis() {
      return Number(held.has('ArrowRight')) - Number(held.has('ArrowLeft'))
    }
  }
}
