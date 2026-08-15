'use strict'

// Deliberately monolithic fixture: presentation, validation, pricing, inventory, reporting, and CLI-ish
// formatting all live together. The benchmark task asks the agent to find sensible module boundaries while
// preserving the public exports pinned by test/messy.test.js.

const DEFAULT_TAX_RATE = 0.2
const DEFAULT_CURRENCY = 'USD'
const DEFAULT_COUNTRY = 'US'
const FREE_SHIPPING_THRESHOLD = 100

const countryNames = {
  US: 'United States',
  NO: 'Norway',
  SE: 'Sweden',
  DK: 'Denmark',
  DE: 'Germany',
  FR: 'France',
  GB: 'United Kingdom'
}

const currencySymbols = {
  USD: '$',
  EUR: '€',
  NOK: 'kr ',
  SEK: 'kr ',
  DKK: 'kr ',
  GBP: '£'
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function compactSpaces(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

function titleWord(word) {
  if (!word) return ''
  return word[0].toUpperCase() + word.slice(1).toLowerCase()
}

function normalizeName(value) {
  return compactSpaces(value)
    .split(' ')
    .filter(Boolean)
    .map(titleWord)
    .join(' ')
}

function normalizeEmail(value) {
  return compactSpaces(value).toLowerCase()
}

function normalizeCountry(value) {
  const code = compactSpaces(value || DEFAULT_COUNTRY).toUpperCase()
  return countryNames[code] ? code : DEFAULT_COUNTRY
}

function normalizeCurrency(value) {
  const code = compactSpaces(value || DEFAULT_CURRENCY).toUpperCase()
  return currencySymbols[code] ? code : DEFAULT_CURRENCY
}

function normalizeSku(value) {
  return compactSpaces(value).toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

function validateCustomer(customer) {
  const errors = []
  if (!customer || typeof customer !== 'object') {
    return ['customer is required']
  }
  if (!compactSpaces(customer.name)) errors.push('customer name is required')
  if (!normalizeEmail(customer.email).includes('@')) errors.push('customer email is invalid')
  if (!compactSpaces(customer.address)) errors.push('customer address is required')
  return errors
}

function validateItem(item) {
  const errors = []
  if (!item || typeof item !== 'object') return ['item is required']
  if (!normalizeSku(item.sku)) errors.push('item sku is required')
  if (!compactSpaces(item.name)) errors.push('item name is required')
  if (asNumber(item.price, -1) < 0) errors.push('item price cannot be negative')
  if (!Number.isInteger(asNumber(item.quantity)) || asNumber(item.quantity) < 1) {
    errors.push('item quantity must be a positive integer')
  }
  return errors
}

function normalizeCustomer(customer = {}) {
  return {
    name: normalizeName(customer.name),
    email: normalizeEmail(customer.email),
    address: compactSpaces(customer.address),
    country: normalizeCountry(customer.country)
  }
}

function normalizeItem(item = {}) {
  return {
    sku: normalizeSku(item.sku),
    name: compactSpaces(item.name),
    price: roundMoney(asNumber(item.price)),
    quantity: Math.max(1, Math.floor(asNumber(item.quantity, 1))),
    taxable: item.taxable !== false,
    weight: Math.max(0, asNumber(item.weight))
  }
}

function lineSubtotal(item) {
  return roundMoney(item.price * item.quantity)
}

function lineWeight(item) {
  return roundMoney(item.weight * item.quantity)
}

function itemCount(items) {
  return items.reduce((total, item) => total + item.quantity, 0)
}

function subtotal(items) {
  return roundMoney(items.reduce((total, item) => total + lineSubtotal(item), 0))
}

function taxableSubtotal(items) {
  return roundMoney(items.filter((item) => item.taxable).reduce((total, item) => total + lineSubtotal(item), 0))
}

function totalWeight(items) {
  return roundMoney(items.reduce((total, item) => total + lineWeight(item), 0))
}

function discountRate(code, value) {
  const normalized = compactSpaces(code).toUpperCase()
  if (normalized === 'SAVE10') return 0.1
  if (normalized === 'SAVE20') return 0.2
  if (normalized === 'WELCOME') return 0.05
  if (normalized === 'VIP') return clamp(asNumber(value, 0.15), 0, 0.3)
  return 0
}

function discountAmount(amount, code, customRate) {
  return roundMoney(amount * discountRate(code, customRate))
}

function shippingAmount(amount, weight, country) {
  if (amount >= FREE_SHIPPING_THRESHOLD) return 0
  const base = country === 'US' ? 6 : 12
  const weightCharge = Math.max(0, weight - 1) * 1.5
  return roundMoney(base + weightCharge)
}

function taxAmount(items, discount, rate) {
  const taxable = taxableSubtotal(items)
  const ratio = subtotal(items) === 0 ? 0 : taxable / subtotal(items)
  const discountedTaxable = Math.max(0, taxable - discount * ratio)
  return roundMoney(discountedTaxable * rate)
}

function summarizeOrders(order = {}) {
  const customer = normalizeCustomer(order.customer)
  const items = Array.isArray(order.items) ? order.items.map(normalizeItem) : []
  const beforeDiscount = subtotal(items)
  const discount = discountAmount(beforeDiscount, order.discountCode, order.discountRate)
  const taxRate = clamp(asNumber(order.taxRate, DEFAULT_TAX_RATE), 0, 1)
  const tax = taxAmount(items, discount, taxRate)
  const shipping = shippingAmount(beforeDiscount - discount, totalWeight(items), customer.country)
  const total = roundMoney(beforeDiscount - discount + tax + shipping)
  return {
    customer,
    items,
    itemCount: itemCount(items),
    subtotal: beforeDiscount,
    discount,
    taxRate,
    tax,
    shipping,
    total,
    currency: normalizeCurrency(order.currency)
  }
}

function money(value, currency = DEFAULT_CURRENCY) {
  const normalized = normalizeCurrency(currency)
  const symbol = currencySymbols[normalized]
  return `${symbol}${roundMoney(value).toFixed(2)}`
}

function padRight(value, width) {
  return String(value).padEnd(width, ' ')
}

function padLeft(value, width) {
  return String(value).padStart(width, ' ')
}

function receiptLine(label, value, width = 34) {
  const room = Math.max(1, width - String(label).length)
  return `${label}${padLeft(value, room)}`
}

function itemReceiptLine(item, currency) {
  const label = `${item.quantity} × ${item.name}`
  return receiptLine(label, money(lineSubtotal(item), currency))
}

function formatReceipt(order = {}) {
  const summary = summarizeOrders(order)
  const width = 34
  const divider = '-'.repeat(width)
  const lines = [
    padRight('BASENJI GOODS', width),
    `Customer: ${summary.customer.name || 'Guest'}`,
    divider,
    ...summary.items.map((item) => itemReceiptLine(item, summary.currency)),
    divider,
    receiptLine('Subtotal', money(summary.subtotal, summary.currency), width),
    receiptLine('Discount', `-${money(summary.discount, summary.currency)}`, width),
    receiptLine('Tax', money(summary.tax, summary.currency), width),
    receiptLine('Shipping', money(summary.shipping, summary.currency), width),
    divider,
    receiptLine('Total', money(summary.total, summary.currency), width)
  ]
  return lines.join('\n')
}

function inventoryIndex(products = []) {
  const index = new Map()
  for (const product of products) {
    const sku = normalizeSku(product.sku)
    if (!sku) continue
    index.set(sku, {
      sku,
      name: compactSpaces(product.name),
      stock: Math.max(0, Math.floor(asNumber(product.stock))),
      reserved: Math.max(0, Math.floor(asNumber(product.reserved))),
      reorderAt: Math.max(0, Math.floor(asNumber(product.reorderAt, 5)))
    })
  }
  return index
}

function availableStock(product) {
  return Math.max(0, product.stock - product.reserved)
}

function canFulfill(items, products) {
  const index = inventoryIndex(products)
  return items.every((raw) => {
    const item = normalizeItem(raw)
    const product = index.get(item.sku)
    return product && availableStock(product) >= item.quantity
  })
}

function reserveInventory(items, products) {
  const index = inventoryIndex(products)
  if (!canFulfill(items, products)) return { ok: false, products }
  for (const raw of items) {
    const item = normalizeItem(raw)
    const product = index.get(item.sku)
    product.reserved += item.quantity
  }
  return { ok: true, products: [...index.values()] }
}

function releaseInventory(items, products) {
  const index = inventoryIndex(products)
  for (const raw of items) {
    const item = normalizeItem(raw)
    const product = index.get(item.sku)
    if (product) product.reserved = Math.max(0, product.reserved - item.quantity)
  }
  return [...index.values()]
}

function productsToReorder(products) {
  return [...inventoryIndex(products).values()]
    .filter((product) => availableStock(product) <= product.reorderAt)
    .sort((a, b) => availableStock(a) - availableStock(b))
}

module.exports = {
  normalizeName,
  summarizeOrders,
  formatReceipt,
  validateCustomer,
  validateItem,
  inventoryIndex,
  canFulfill,
  reserveInventory,
  releaseInventory,
  productsToReorder
}
