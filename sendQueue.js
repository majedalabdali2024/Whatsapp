/**
 * طابور إرسال لكل جلسة: يضمن مرور MIN_SEND_INTERVAL_MS (افتراضيًا 15 ثانية) على الأقل
 * بين أي رسالتين صادرتين من نفس الجلسة/الرقم، بالترتيب (FIFO). الجلسات المختلفة لا تنتظر بعضها.
 *
 * ملاحظة: الطابور في الذاكرة فقط — أي إعادة تشغيل/نشر تُسقط الرسائل التي لم تُرسل بعد.
 */

const DEFAULT_INTERVAL_MS = 15000

const getIntervalMs = () => {
    const v = parseInt(process.env.MIN_SEND_INTERVAL_MS ?? '', 10)
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_INTERVAL_MS
}

/** sessionId -> { items: Array<{task, meta}>, running: boolean, inFlight: boolean, lastSentAt: number } */
const queues = new Map()

let log = {
    info: () => {},
    error: (...args) => console.error(...args),
}

const setLogger = (logger) => {
    if (logger) log = logger
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getQueue = (sessionId) => {
    let q = queues.get(sessionId)
    if (!q) {
        q = { items: [], running: false, inFlight: false, lastSentAt: -Infinity }
        queues.set(sessionId, q)
    }
    return q
}

const run = async (sessionId, q) => {
    q.running = true
    try {
        while (q.items.length > 0) {
            const wait = q.lastSentAt + getIntervalMs() - Date.now()
            if (wait > 0) await sleep(wait)

            const { task, meta } = q.items.shift()
            q.inFlight = true
            try {
                await task()
                log.info('Queued message sent', { sessionId, ...meta, remaining: q.items.length })
            } catch (error) {
                // الفشل لا يوقف الطابور: نسجّله ونكمل بعد الفاصل
                log.error('Queued message failed', { sessionId, ...meta, error: error?.message ?? String(error) })
            } finally {
                q.inFlight = false
                q.lastSentAt = Date.now()
            }
        }
    } finally {
        q.running = false
    }
}

/**
 * يضيف مهمة إرسال إلى طابور الجلسة ويعود فورًا.
 * @param {string} sessionId
 * @param {() => Promise<any>} task
 * @param {object} [meta] بيانات للسجل فقط
 * @returns {{ position: number, etaSeconds: number }}
 */
const enqueue = (sessionId, task, meta = {}) => {
    const q = getQueue(sessionId)
    q.items.push({ task, meta })

    const interval = getIntervalMs()
    // الموضع يشمل الرسالة الجاري إرسالها الآن (1 = ستُرسل الآن/التالية)
    const position = q.items.length + (q.inFlight ? 1 : 0)
    const firstWait = q.inFlight ? interval : Math.max(0, q.lastSentAt + interval - Date.now())
    const etaSeconds = Math.ceil((firstWait + (q.items.length - 1) * interval) / 1000)

    if (!q.running) run(sessionId, q)

    return { position, etaSeconds }
}

const pendingCount = (sessionId) => {
    if (sessionId !== undefined) return queues.get(sessionId)?.items.length ?? 0
    let total = 0
    queues.forEach((q) => (total += q.items.length))
    return total
}

export { enqueue, pendingCount, getIntervalMs, setLogger }
