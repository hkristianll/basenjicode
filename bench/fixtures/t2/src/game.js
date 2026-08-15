import { createInput } from './input.js'
import { Player } from './player.js'

const canvas = document.querySelector('#game')
const ctx = canvas.getContext('2d')
const input = createInput()
const player = new Player(303, 320)
const state = {
  score: 0 // SEEDED_BUG: add the missing comma here
  lives: 3
}

function frame() {
  player.update(input.axis(), canvas.width)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  player.draw(ctx)
  ctx.fillStyle = '#e2e8f0'
  ctx.fillText(`Score: ${state.score}  Lives: ${state.lives}`, 12, 20)
  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
