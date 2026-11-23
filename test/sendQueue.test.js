import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

process.env.MIN_SEND_INTERVAL_MS = '15000'
mock.timers.enable({ apis: ['setTimeout', 'Date'] })

const { enqueue } = await import('../sendQueue.js')

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('same session: sent >=15s apart, in order; enqueue returns immediately', async () => {
    const sent = []
    const a = enqueue('s1', async () => sent.push(['a', Date.now()]))
    const b = enqueue('s1', async () => sent.push(['b', Date.now()]))

    assert.equal(a.position, 1)
    assert.equal(b.position, 2)
    assert.equal(b.etaSeconds, 15)

    await flush()
    assert.deepEqual(sent.map((x) => x[0]), ['a'])

    mock.timers.tick(14999)
    await flush()
    assert.equal(sent.length, 1, 'second message must not go before 15s')

    mock.timers.tick(1)
    await flush()
    assert.deepEqual(sent.map((x) => x[0]), ['a', 'b'])
    assert.ok(sent[1][1] - sent[0][1] >= 15000)
})

test('different sessions do not wait for each other', async () => {
    const sent = []
    enqueue('x', async () => sent.push('x'))
    enqueue('y', async () => sent.push('y'))
    await flush()
    assert.deepEqual(sent.sort(), ['x', 'y'])
})

test('a failed send does not block the queue', async () => {
    const sent = []
    enqueue('f', async () => {
        throw new Error('boom')
    })
    enqueue('f', async () => sent.push('next'))
    await flush()
    assert.equal(sent.length, 0)
    mock.timers.tick(15000)
    await flush()
    assert.deepEqual(sent, ['next'])
})
