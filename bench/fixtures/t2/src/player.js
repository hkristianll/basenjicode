export class Player {
  constructor(x, y) {
    this.x = x
    this.y = y
    this.width = 34
    this.height = 18
  }

  update(axis, bounds) {
    this.x = Math.max(0, Math.min(bounds - this.width, this.x + axis * 5))
  }

  draw(ctx) {
    ctx.fillStyle = '#f97316'
    ctx.fillRect(this.x, this.y, this.width, this.height)
  }
}
