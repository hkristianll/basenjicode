'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeName, summarizeOrders, formatReceipt } = require('../messy.js')

test('normalizes a customer name', () => {
  assert.equal(normalizeName('  aDA   lovELace  '), 'Ada Lovelace')
})

test('summarizes an order without shipping above the free threshold', () => {
  const summary = summarizeOrders({
    customer: { name: 'Ada', email: 'ada@example.com', address: '1 Code Way', country: 'US' },
    items: [{ sku: 'BOOK', name: 'Book', price: 60, quantity: 2, weight: 1 }],
    taxRate: 0.1
  })
  assert.deepEqual(
    { subtotal: summary.subtotal, tax: summary.tax, shipping: summary.shipping, total: summary.total },
    { subtotal: 120, tax: 12, shipping: 0, total: 132 }
  )
})

test('formats a receipt with customer, item, and total', () => {
  const receipt = formatReceipt({
    customer: { name: 'grace hopper', email: 'grace@example.com', address: '2 Navy Rd', country: 'US' },
    items: [{ sku: 'MUG', name: 'Debug Mug', price: 20, quantity: 1 }],
    taxRate: 0
  })
  assert.match(receipt, /Customer: Grace Hopper/)
  assert.match(receipt, /1 × Debug Mug/)
  assert.match(receipt, /Total\s+\$26\.00/)
})
