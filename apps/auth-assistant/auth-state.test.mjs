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

test('requires Sub2API auth storage for token.dialoguedui.com', () => {
  assert.equal(hasLikelyAuthState([{ name: 'theme', value: 'dark' }], { theme: 'dark' }, 'token.dialoguedui.com'), false)
  assert.equal(hasLikelyAuthState([], { auth_token: 'opaque-token' }, 'token.dialoguedui.com'), true)
  assert.equal(hasLikelyAuthState([{ name: 'session', value: 'opaque-session' }], {}, 'token.dialoguedui.com'), false)
})

test('requires New API auth state for chybenzun.top', () => {
  assert.equal(hasLikelyAuthState([{ name: 'aff', value: '123' }], { aff: '123' }, 'chybenzun.top'), false)
  assert.equal(hasLikelyAuthState([], { uid: '42' }, 'chybenzun.top'), true)
  assert.equal(hasLikelyAuthState([], { user: '{"id":42}' }, 'www.chybenzun.top'), true)
  assert.equal(hasLikelyAuthState([{ name: 'session', value: 'opaque-session' }], {}, 'chybenzun.top'), false)
})
