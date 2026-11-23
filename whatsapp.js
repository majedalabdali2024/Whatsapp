import { existsSync, unlinkSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import makeWASocket from '@whiskeysockets/baileys'
import { useMultiFileAuthState, Browsers, DisconnectReason, delay, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { toDataURL } from 'qrcode'
import __dirname from './dirname.js'
import response from './response.js'
import logger from './logger.js'

const sessions = new Map()
const retries = new Map()

/**
 * Recently sent messages (id -> proto message), so Baileys can re-encrypt and resend them
 * when a recipient's phone fails to decrypt and asks for a retry. Without `getMessage`
 * the recipient stays on "Waiting for this message. This may take a while".
 */
const SENT_CACHE_MAX = 2000
const sentMessages = new Map()

const rememberSent = (result) => {
    const id = result?.key?.id
    if (!id || !result.message) return
    sentMessages.set(id, result.message)
    if (sentMessages.size > SENT_CACHE_MAX) {
        sentMessages.delete(sentMessages.keys().next().value)
    }
}

const getMessage = async (key) => sentMessages.get(key?.id)

/** مجلد جذر جلسات Baileys — على Railway اربط Volume واضبط WHATSAPP_SESSIONS_PATH=/data/sessions */
const SESSIONS_ROOT = process.env.WHATSAPP_SESSIONS_PATH
    ? process.env.WHATSAPP_SESSIONS_PATH.replace(/\/$/, '')
    : join(__dirname, 'sessions')

const sessionsDir = (sessionId = '') => {
    return join(SESSIONS_ROOT, sessionId ? `${sessionId}.json` : '')
}

const storeDir = (storeFile = '') => {
    return join(SESSIONS_ROOT, storeFile ? `${storeFile}.json` : '')
}
const isSessionExists = (sessionId) => {
    return sessions.has(sessionId)
}

const isSessionFileExists = (name) => {
    return existsSync(sessionsDir(name))
}

const shouldReconnect = (sessionId) => {
    let maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
    let attempts = retries.get(sessionId) ?? 0

    maxRetries = maxRetries < 1 ? 1 : maxRetries

    if (attempts < maxRetries) {
        ++attempts

        logger.info('Reconnecting...', { attempts, sessionId, maxRetries })
        retries.set(sessionId, attempts)

        return true
    }

    logger.warn(`Max retries reached for session ${sessionId}`, { attempts, maxRetries });
    return false
}

const createSession = async (sessionId, isLegacy = false, res = null) => {
    logger.info(`Creating session: ${sessionId}`, { sessionId, isLegacy });
    const sessionFile = (isLegacy ? 'legacy_' : 'md_') + sessionId

    const { state, saveCreds } = await useMultiFileAuthState(sessionsDir(sessionFile))
    logger.info(`Session state loaded for: ${sessionId}`);

    // Fetch latest WhatsApp version with fallback
    let version
    try {
        const versionInfo = await fetchLatestBaileysVersion()
        version = versionInfo.version
        logger.info(`Using WA version: ${version}, isLatest: ${versionInfo.isLatest}`, { sessionId });
    } catch (error) {
        version = [2, 3000, 1015901307]
        logger.warn(`Failed to fetch latest version, using fallback: ${version}`, { sessionId, error: error.message });
    }

    /**
     * @type {(import('@adiwajshing/baileys').LegacySocketConfig|import('@adiwajshing/baileys').SocketConfig)}
     */
    const createTimeoutMs = parseInt(process.env.SESSION_CREATE_TIMEOUT_MS ?? '90000', 10)
    const qrTimeoutMs = parseInt(process.env.QR_TIMEOUT_MS ?? '60000', 10)

    const waConfig = {
        auth: state,
        printQRInTerminal: false,
        version,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        qrTimeout: qrTimeoutMs,
        browser: ['Chrome (Windows)', 'Chrome', '130.0.0.0'],
        getMessage,
    }

    /**
     * @type {import('@whiskeysockets/baileys').AnyWASocket}
     */
    let wa
    try {
        wa = makeWASocket(waConfig)
    } catch (error) {
        logger.error(`Failed to create WASocket for session ${sessionId}`, { error: error.message, stack: error.stack });
        if (res && !res.headersSent) {
            response(res, 500, false, `Failed to create WhatsApp socket: ${error.message}`)
        }
        return
    }

    // HTTP wait for first QR / open — default 90s (Railway cold start + WA handshake)
    let responseTimeout = null
    if (res && !res.headersSent) {
        responseTimeout = setTimeout(() => {
            if (res && !res.headersSent) {
                logger.warn(`Session ${sessionId} creation timed out waiting for QR/connection`);
                response(res, 504, false, 'Session creation timed out. Please try again.')
            }
        }, Number.isFinite(createTimeoutMs) ? createTimeoutMs : 90000)
    }

    sessions.set(sessionId, {
        ...wa,
        isLegacy,
        authenticated: false,
        pairing: true,
        lastQr: null,
        lastQrAt: null,
    })

    wa.ev.on('creds.update', async (...args) => {
        try {
            await saveCreds(...args)
        } catch (error) {
            logger.error(`Failed to save credentials for session ${sessionId}`, { error: error.message });
        }
    })

    wa.ev.on('chats.set', ({ chats }) => {
        if (isLegacy) {
            // store.chats.insertIfAbsent(...chats) // Store not available
        }
    })

    wa.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0]
        logger.debug(`Message received for session ${sessionId}`, {
            fromMe: message.key.fromMe,
            type: m.type,
            remoteJid: message.key.remoteJid
        });

        if (!message.key.fromMe && m.type === 'notify') {
            await delay(1000)

            if (isLegacy) {
                try {
                    await wa.chatRead(message.key, 1)
                    logger.debug(`Marked message as read (legacy) for session ${sessionId}`);
                } catch (error) {
                    logger.error(`Failed to mark message as read (legacy) for session ${sessionId}`, { error: error.message });
                }

            } else {
                try {
                    await wa.readMessages([message.key])
                    logger.debug(`Sent read receipt for session ${sessionId}`);
                } catch (error) {
                    logger.error(`Failed to send read receipt for session ${sessionId}`, { error: error.message });
                }

            }
        }
    })

    wa.ev.on('connection.update', async (update) => {
        try {
            const { connection, lastDisconnect } = update
            const statusCode = lastDisconnect?.error?.output?.statusCode

            logger.info(`Connection update for session ${sessionId}`, {
                connection,
                statusCode,
                hasQR: !!update.qr,
                lastDisconnectError: lastDisconnect?.error?.message,
                updateKeys: Object.keys(update)
            });

            if (connection === 'open') {
                logger.info(`Session ${sessionId} connected successfully`);
                // Mark session as authenticated (QR was scanned or creds restored)
                const sess = sessions.get(sessionId)
                if (sess) {
                    sess.authenticated = true
                    sess.pairing = false
                    sess.lastQr = null
                    sess.lastQrAt = null
                }
                retries.delete(sessionId)
                if (responseTimeout) clearTimeout(responseTimeout)

                if (res && !res.headersSent) {
                    response(res, 200, true, 'Session connected successfully.', { connected: true })
                }
            }

            if (connection === 'close') {
                // If session was intentionally disconnected (removed from sessions map), don't reconnect
                if (!sessions.has(sessionId)) {
                    logger.info(`Session ${sessionId} was intentionally disconnected, skipping reconnection`);
                    if (responseTimeout) clearTimeout(responseTimeout)
                    if (res && !res.headersSent) {
                        response(res, 200, true, 'Session disconnected.')
                    }
                    return;
                }

                logger.warn(`Session ${sessionId} connection closed`, {
                    statusCode,
                    loggedOut: statusCode === DisconnectReason.loggedOut,
                    retries: retries.get(sessionId) ?? 0
                });

                if (statusCode === DisconnectReason.loggedOut) {
                    logger.warn(`Session ${sessionId} was logged out, deleting old creds and retrying for fresh QR`, {
                        statusCode
                    });

                    // Delete old (expired) credentials
                    deleteSession(sessionId, isLegacy)

                    // Immediately retry - this time with no saved creds, so Baileys will generate a QR code
                    if (responseTimeout) clearTimeout(responseTimeout)
                    setTimeout(() => {
                        logger.info(`Retrying session ${sessionId} after loggedOut to get fresh QR`);
                        createSession(sessionId, isLegacy, res)
                    }, 500)
                    return
                }

                if (!shouldReconnect(sessionId)) {
                    logger.error(`Session ${sessionId} will not reconnect`, {
                        reason: 'max retries reached'
                    });

                    if (responseTimeout) clearTimeout(responseTimeout)
                    if (res && !res.headersSent) {
                        response(res, 500, false, 'Unable to create session.')
                    }

                    return deleteSession(sessionId, isLegacy)
                }

                const reconnectDelay = statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0);
                logger.info(`Scheduling reconnection for session ${sessionId} in ${reconnectDelay}ms`);

                setTimeout(
                    () => {
                        logger.info(`Attempting to reconnect session ${sessionId}`);
                        createSession(sessionId, isLegacy, res)
                    },
                    reconnectDelay
                )
            }

            if (update.qr) {
                logger.info(`QR code received for session ${sessionId}`, {
                    hasResponse: !!res,
                    responseHeadersSent: res?.headersSent
                });

                let qrDataUrl = null
                try {
                    qrDataUrl = await toDataURL(update.qr)
                } catch (error) {
                    logger.error(`Failed to create QR code data URL for session ${sessionId}`, { error: error.message });
                    if (res && !res.headersSent) {
                        if (responseTimeout) clearTimeout(responseTimeout)
                        response(res, 500, false, 'Unable to create QR code.')
                    }
                    return
                }

                // Always keep the latest QR for polling — NEVER logout on refresh.
                // (Previous bug: after first HTTP response, Baileys QR refresh deleted the session.)
                const sess = sessions.get(sessionId)
                if (sess) {
                    sess.lastQr = qrDataUrl
                    sess.lastQrAt = Date.now()
                    sess.pairing = true
                    sess.authenticated = false
                }

                if (res && !res.headersSent) {
                    if (responseTimeout) clearTimeout(responseTimeout)
                    logger.info(`QR code converted to data URL successfully for session ${sessionId}`);
                    response(res, 200, true, 'QR code received, please scan the QR code.', { qr: qrDataUrl })
                    return
                }

                logger.info(`QR refreshed for session ${sessionId} (clients should poll GET /session/qr/:id)`)
            }
        } catch (error) {
            logger.error(`Error in connection.update handler for session ${sessionId}`, { error: error.message, stack: error.stack });
            if (responseTimeout) clearTimeout(responseTimeout)
            if (res && !res.headersSent) {
                response(res, 500, false, `Connection error: ${error.message}`)
            }
        }
    })
}

/**
 * @returns {(import('@adiwajshing/baileys').AnyWASocket|null)}
 */
const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

const deleteSession = (sessionId, isLegacy = false) => {
    const sessionFile = (isLegacy ? 'legacy_' : 'md_') + sessionId
    const storeFile = `${sessionId}_store`

    logger.info(`Deleting session ${sessionId}`, { sessionFile, storeFile, isLegacy });

    try {
        const sessionPath = sessionsDir(sessionFile)
        if (existsSync(sessionPath)) {
            rmSync(sessionPath, { recursive: true, force: true })
            logger.info(`Deleted session directory for ${sessionId}`);
        }

        const storePath = storeDir(storeFile)
        if (existsSync(storePath)) {
            rmSync(storePath, { force: true })
            logger.info(`Deleted store file for ${sessionId}`);
        }
    } catch (error) {
        logger.error(`Error deleting session files for ${sessionId}`, { error: error.message });
    }

    try {
        sessions.delete(sessionId)
        retries.delete(sessionId)
        logger.info(`Removed session ${sessionId} from memory`);
    } catch (error) {
        logger.error(`Error removing session from memory for ${sessionId}`, { error: error.message });
    }
}

const getSessionStatus = (sessionId) => {
    const session = sessions.get(sessionId)
    if (!session) return null

    return {
        id: sessionId,
        isLegacy: session.isLegacy ?? false,
        connected: session.authenticated === true,
        pairing: session.pairing === true && session.authenticated !== true,
        hasQr: !!session.lastQr,
        qrUpdatedAt: session.lastQrAt ?? null,
    }
}

/** Latest QR data-URL for an in-progress pairing session (null if connected / none). */
const getSessionQr = (sessionId) => {
    const session = sessions.get(sessionId)
    if (!session) return null
    if (session.authenticated === true) {
        return {
            id: sessionId,
            connected: true,
            pairing: false,
            qr: null,
            qrUpdatedAt: null,
        }
    }
    return {
        id: sessionId,
        connected: false,
        pairing: session.pairing === true,
        qr: session.lastQr ?? null,
        qrUpdatedAt: session.lastQrAt ?? null,
    }
}

/** Force-wipe in-memory + disk session so a fresh QR can be issued. */
const forceDeleteSession = async (sessionId) => {
    const session = sessions.get(sessionId)
    if (session) {
        try {
            await session.logout()
        } catch {
            try { await session.ws?.close() } catch { /* ignore */ }
        }
        deleteSession(sessionId, session.isLegacy ?? false)
    } else {
        deleteSession(sessionId, false)
        deleteSession(sessionId, true)
    }
}

const disconnectSession = async (sessionId) => {
    const session = sessions.get(sessionId)
    if (!session) return false

    try {
        // Remove from map FIRST so the close handler knows it was intentional
        sessions.delete(sessionId)
        retries.delete(sessionId)
        await session.ws?.close()
        logger.info(`Session ${sessionId} disconnected (auth preserved)`);
        return true
    } catch (error) {
        logger.error(`Error disconnecting session ${sessionId}`, { error: error.message });
        return false
    }
}

const getChatList = (sessionId, isGroup = false) => {
    const filter = isGroup ? '@g.us' : '@s.whatsapp.net'
    const session = getSession(sessionId)
    if (!session) return []

    // Prefer in-memory store when available
    try {
        const chats = session.store?.chats
        if (chats && typeof chats.filter === 'function') {
            return chats.filter((chat) => chat.id?.endsWith(filter))
        }
    } catch {
        /* fall through */
    }
    return []
}

/** List groups the linked account participates in (works without store). */
const fetchParticipatingGroups = async (sessionId) => {
    const session = getSession(sessionId)
    if (!session) return []
    if (typeof session.groupFetchAllParticipating !== 'function') {
        return getChatList(sessionId, true)
    }
    const map = await session.groupFetchAllParticipating()
    return Object.values(map || {}).map((g) => ({
        id: g.id,
        name: g.subject || g.name || g.id,
        subject: g.subject || '',
        size: g.size || (g.participants ? g.participants.length : 0),
    }))
}

/** Resolve chat.whatsapp.com invite URL/code -> group JID */
const resolveGroupInvite = async (sessionId, inviteInput) => {
    const session = getSession(sessionId)
    if (!session) throw new Error('Session not found')
    let code = String(inviteInput || '').trim()
    const m = code.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)
    if (m) code = m[1]
    code = code.replace(/^\//, '').split('?')[0].trim()
    if (!code) throw new Error('Invalid invite code')
    if (typeof session.groupGetInviteInfo !== 'function') {
        throw new Error('Invite resolve not supported')
    }
    const info = await session.groupGetInviteInfo(code)
    return {
        id: info.id,
        name: info.subject || info.name || info.id,
        subject: info.subject || '',
    }
}

/**
 * @param {import('@adiwajshing/baileys').AnyWASocket} session
 */
const isExists = async (session, jid, isGroup = false) => {
    try {
        let result

        if (isGroup) {
            result = await session.groupMetadata(jid)

            return Boolean(result.id)
        }

        if (session.isLegacy) {
            result = await session.onWhatsApp(jid)
        } else {
            ;[result] = await session.onWhatsApp(jid)
        }

        return result.exists
    } catch {
        return false
    }
}

/**
 * @param {import('@adiwajshing/baileys').AnyWASocket} session
 */
const sendMessage = async (session, receiver, message) => {
    try {
        logger.info('Sending message', { receiver, messageKeys: Object.keys(message) });
        await delay(1000)

        const result = await session.sendMessage(receiver, message)
        rememberSent(result)
        logger.info('Message sent successfully', { receiver, messageId: result?.key?.id });
        return result
    } catch (error) {
        logger.error('Failed to send message', { receiver, error: error.message });
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

// mimetype = 'application/pdf'
const sendMediaMessage = async (session, receiver, messageBase64 ,mimetype , filename ,caption) => {
    try {
        logger.info('Sending media message', { receiver, mimetype, filename, hasCaption: !!caption });
        await delay(1000)

        const result = await session.sendMessage(receiver, {
            document:  Buffer.from(messageBase64, "base64"),
            mimetype: mimetype,
            fileName: filename ,
            caption: caption
        });
        rememberSent(result)

        logger.info('Media message sent successfully', { receiver, filename, messageId: result?.key?.id });
        return result;
    } catch (error) {
        logger.error('Failed to send media message', { receiver, filename, error: error.message });
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}
/* // send a reply messagge
const sentMsg  = await sock.sendMessage(id, { text: 'oh hello there' }, { quoted: message })
// send a mentions message
const sentMsg  = await sock.sendMessage(id, { text: '@12345678901', mentions: ['12345678901@s.whatsapp.net'] })
// send a location!
const sentMsg  = await sock.sendMessage(
    id,
    { location: { degreesLatitude: 24.121231, degreesLongitude: 55.1121221 } }
)
// send a contact!
const vcard = 'BEGIN:VCARD\n' // metadata of the contact card
            + 'VERSION:3.0\n'
            + 'FN:Jeff Singh\n' // full name
            + 'ORG:Ashoka Uni;\n' // the organization of the contact
            + 'TEL;type=CELL;type=VOICE;waid=911234567890:+91 12345 67890\n' // WhatsApp ID + phone number
            + 'END:VCARD'
const sentMsg  = await sock.sendMessage(
    id,
    {
        contacts: {
            displayName: 'Jeff',
            contacts: [{ vcard }]
        }
    }
)

// send a buttons message!
const buttons = [
  {buttonId: 'id1', buttonText: {displayText: 'Button 1'}, type: 1},
  {buttonId: 'id2', buttonText: {displayText: 'Button 2'}, type: 1},
  {buttonId: 'id3', buttonText: {displayText: 'Button 3'}, type: 1}
]

const buttonMessage = {
    text: "Hi it's button message",
    footer: 'Hello World',
    buttons: buttons,
    headerType: 1
}

const sendMsg = await sock.sendMessage(id, buttonMessage)

//send a template message!
const templateButtons = [
    {index: 1, urlButton: {displayText: '⭐ Star Baileys on GitHub!', url: 'https://github.com/adiwajshing/Baileys'}},
    {index: 2, callButton: {displayText: 'Call me!', phoneNumber: '+1 (234) 5678-901'}},
    {index: 3, quickReplyButton: {displayText: 'This is a reply, just like normal buttons!', id: 'id-like-buttons-message'}},
]

const templateMessage = {
    text: "Hi it's a template message",
    footer: 'Hello World',
    templateButtons: templateButtons
}

const sendMsg = await sock.sendMessage(id, templateMessage)

// send a list message!
const sections = [
    {
    title: "Section 1",
    rows: [
        {title: "Option 1", rowId: "option1"},
        {title: "Option 2", rowId: "option2", description: "This is a description"}
    ]
    },
   {
    title: "Section 2",
    rows: [
        {title: "Option 3", rowId: "option3"},
        {title: "Option 4", rowId: "option4", description: "This is a description V2"}
    ]
    },
]

const listMessage = {
  text: "This is a list",
  footer: "nice footer, link: https://google.com",
  title: "Amazing boldfaced list title",
  buttonText: "Required, text on the button to view the list",
  sections
}

const sendMsg = await sock.sendMessage(id, listMessage)

const reactionMessage = {
    react: {
        text: "💖", // use an empty string to remove the reaction
        key: message.key
    }
}
 */
const formatPhone = (phone) => {
    if (phone.endsWith('@s.whatsapp.net')) {
        return phone
    }

    let formatted = phone.replace(/\D/g, '')

    return (formatted += '@s.whatsapp.net')
}

const formatGroup = (group) => {
    if (group.endsWith('@g.us')) {
        return group
    }

    let formatted = group.replace(/[^\d-]/g, '')

    return (formatted += '@g.us')
}

const cleanup = () => {
    console.log('Running cleanup before exit.')

    sessions.forEach((session, sessionId) => {
        if (!session.isLegacy) {
            session.store.writeToFile(sessionsDir(`${sessionId}_store`))
        }
    })
}

const init = () => {
    logger.info('Initializing WhatsApp service...');

    // Ensure sessions directory exists
    const sessDir = sessionsDir()
    if (!existsSync(sessDir)) {
        mkdirSync(sessDir, { recursive: true })
        logger.info('Created sessions directory');
    }

    // By default sessions are created on demand: when a client calls POST /session/add,
    // Baileys re-authenticates from the saved creds without a new QR scan.
    // With AUTO_RESTORE_SESSIONS=true, paired sessions reconnect on startup instead,
    // so sending keeps working after a restart without anyone calling /session/add.
    if (process.env.AUTO_RESTORE_SESSIONS === 'true') {
        restoreSessions()
        return
    }
    logger.info('Initialization complete (sessions will be created on demand)');
}

/** Reconnects every session that finished pairing (its creds.json has a registered account). */
const restoreSessions = () => {
    let entries = []
    try {
        entries = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    } catch (error) {
        logger.error('Failed to read sessions directory for restore', { error: error.message });
        return
    }

    const paired = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name.match(/^(md|legacy)_(.+)\.json$/))
        .filter(Boolean)
        .filter(([name]) => {
            try {
                const creds = JSON.parse(readFileSync(join(SESSIONS_ROOT, name, 'creds.json'), 'utf8'))
                return Boolean(creds?.me?.id)
            } catch {
                return false
            }
        })

    logger.info(`Restoring ${paired.length} saved session(s)`, { sessions: paired.map(([, , id]) => id) });

    paired.forEach(([, kind, sessionId], i) => {
        // Stagger connections so several sessions don't hit WhatsApp at the same instant
        setTimeout(() => {
            if (isSessionExists(sessionId)) return
            createSession(sessionId, kind === 'legacy').catch((error) => {
                logger.error(`Failed to restore session ${sessionId}`, { error: error.message });
            })
        }, i * 2000)
    })
}

export {
    isSessionExists,
    createSession,
    getSession,
    deleteSession,
    forceDeleteSession,
    disconnectSession,
    getSessionStatus,
    getSessionQr,
    getChatList,
    fetchParticipatingGroups,
    resolveGroupInvite,
    isExists,
    sendMessage,
    sendMediaMessage,
    formatPhone,
    formatGroup,
    cleanup,
    init,
}
