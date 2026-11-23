import { getSession, getChatList, isExists, sendMessage, formatPhone, formatGroup, sendMediaMessage } from './../whatsapp.js'
import response from './../response.js'
import logger from './../logger.js'
import { enqueue, setLogger } from './../sendQueue.js'

setLogger(logger)

/**
 * يضع الإرسال في طابور الجلسة (فاصل MIN_SEND_INTERVAL_MS بين الرسائل) ويعود فورًا.
 * نأخذ الجلسة وقت الإرسال الفعلي لأن إعادة الاتصال تستبدل كائن الجلسة.
 */
const queueSend = (sessionId, jid, doSend) =>
    enqueue(
        sessionId,
        async () => {
            const session = getSession(sessionId)
            if (!session) throw new Error('Session not found at send time')
            await doSend(session)
        },
        { receiver: jid }
    )

/** Phone or WhatsApp group JID (@g.us). */
const resolveReceiver = (raw) => {
    const s = String(raw ?? '').trim()
    if (s.endsWith('@g.us') || /@g\.us$/i.test(s)) {
        return { jid: formatGroup(s), isGroup: true }
    }
    // Also accept bare group id like 1203630...-... without suffix if contains hyphen typical of groups
    if (/^\d{10,}-\d+$/.test(s)) {
        return { jid: formatGroup(s), isGroup: true }
    }
    return { jid: formatPhone(s), isGroup: false }
}

const getList = (req, res) => {
    return response(res, 200, true, '', getChatList(res.locals.sessionId))
}

const send = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { jid, isGroup } = resolveReceiver(req.body.receiver)
    const { message } = req.body

    try {
        const exists = await isExists(session, jid, isGroup)

        if (!exists) {
            return response(res, 400, false, isGroup ? 'The group is not exists.' : 'The receiver number is not exists.')
        }

        const { position, etaSeconds } = queueSend(res.locals.sessionId, jid, (s) =>
            sendMessage(s, jid, { text: message })
        )

        response(res, 200, true, 'The message has been successfully sent.', { queued: true, position, etaSeconds })
    } catch {
        response(res, 500, false, 'Failed to send the message.')
    }
}

const sendMedia = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { jid, isGroup } = resolveReceiver(req.body.receiver)
    const mimetype = req.body.mimeType
    const filename = req.body.fileName
    const caption = req.body.caption
    const message = req.body.message

    try {
        const exists = await isExists(session, jid, isGroup)

        if (!exists) {
            return response(res, 400, false, isGroup ? 'The group is not exists.' : 'The receiver number is not exists.')
        }

        const { position, etaSeconds } = queueSend(res.locals.sessionId, jid, (s) =>
            sendMediaMessage(s, jid, message, mimetype, filename, caption)
        )

        response(res, 200, true, 'The message has been successfully sent.', { queued: true, position, etaSeconds })
    } catch {
        response(res, 500, false, 'Failed to send the message.')
    }
}

const sendBulk = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const errors = []
    let queued = 0

    for (const [key, data] of req.body.entries()) {
        if (!data.receiver || !data.message) {
            errors.push(key)
            continue
        }

        const { jid, isGroup } = resolveReceiver(data.receiver)
        data.receiver = jid

        try {
            const exists = await isExists(session, jid, isGroup)

            if (!exists) {
                errors.push(key)
                continue
            }

            const text = data.message
            queueSend(res.locals.sessionId, jid, (s) => sendMessage(s, jid, { text }))
            queued++
        } catch {
            errors.push(key)
        }
    }

    if (errors.length === 0) {
        return response(res, 200, true, 'All messages has been successfully sent.', { queued })
    }

    const isAllFailed = errors.length === req.body.length

    response(
        res,
        isAllFailed ? 500 : 200,
        !isAllFailed,
        isAllFailed ? 'Failed to send all messages.' : 'Some messages has been successfully sent.',
        { errors, queued }
    )
}

export { getList, send, sendBulk, sendMedia }
