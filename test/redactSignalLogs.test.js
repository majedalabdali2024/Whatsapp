import { test } from 'node:test'
import assert from 'node:assert/strict'

const captured = []
const realInfo = console.info
console.info = (...args) => captured.push(args)
await import('../redactSignalLogs.js')

test('libsignal session dumps are reduced to their message text', () => {
    console.info('Closing session:', { privKey: Buffer.from('secret') })
    console.info('normal', { a: 1 })
    console.info = realInfo
    assert.deepEqual(captured[0], ['Closing session'])
    assert.deepEqual(captured[1], ['normal', { a: 1 }])
})
