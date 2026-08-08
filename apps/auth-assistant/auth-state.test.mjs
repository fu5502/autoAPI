import test from 'node:test'
import assert from 'node:assert/strict'
import { hasLikelyAuthState } from './auth-state.mjs'

test('accepts a non-empty cookie even when the site uses an unknown cookie name', () => {
  assert.equal(hasLikelyAuthState([{ name: 'sid_9f2', value: 'opaque-session' }], {}), true)
})

test('accepts persisted SPA state under an arbitrary storage key', () => {
  assert.equal(hasLikelyAuthState([], { 'persist:root': '{"account":{"id":42}}' }), true)
})

test('rejects an empty snapshot', () => {
  assert.equal(hasLikelyAuthState([{ name: 'sid_9f2', value: '' }], { theme: '' }), false)
})
