import { existsSync, unlinkSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import makeWASocket from '@whiskeysockets/baileys'
import { useMultiFileAuthState, Browsers, DisconnectReason, delay, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { toDataURL } from 'qrcode'
import __dirname from './dirname.js'
import response from './response.js'
import logger from './logger.js'

const sessions = new Map()
const retries = new Map()

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
    const waConfig = {
        auth: state,
        printQRInTerminal: false,
        version,
        connectTimeoutMs: 30000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        browser: ['Chrome (Windows)', 'Chrome', '130.0.0.0'],
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

    // Set a timeout for the HTTP response - if no QR or connection within 45s, send error
    let responseTimeout = null
    if (res && !res.headersSent) {
        responseTimeout = setTimeout(() => {
            if (res && !res.headersSent) {
                logger.warn(`Session ${sessionId} creation timed out waiting for QR/connection`);
                response(res, 504, false, 'Session creation timed out. Please try again.')
            }
        }, 45000)
    }

    sessions.set(sessionId, { ...wa, isLegacy, authenticated: false })

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
                    await wa.sendReadReceipt(message.key.remoteJid, message.key.participant, [message.key.id])
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
                if (sess) sess.authenticated = true
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

                if (res && !res.headersSent) {
                    if (responseTimeout) clearTimeout(responseTimeout)
                    try {
                        const qr = await toDataURL(update.qr)
                        logger.info(`QR code converted to data URL successfully for session ${sessionId}`);

                        response(res, 200, true, 'QR code received, please scan the QR code.', { qr })
                    } catch (error) {
                        logger.error(`Failed to create QR code data URL for session ${sessionId}`, { error: error.message });
                        response(res, 500, false, 'Unable to create QR code.')
                    }

                    return
                }

                logger.warn(`QR code received but no response object available for session ${sessionId}, logging out`);
                try {
                    await wa.logout()
                    logger.info(`Session ${sessionId} logged out after QR code without response`);
                } catch (error) {
                    logger.error(`Failed to logout session ${sessionId}`, { error: error.message });
                } finally {
                    deleteSession(sessionId, isLegacy)
                }
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
        connected: session.authenticated === true
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

    return getSession(sessionId).store.chats.filter((chat) => {
        return chat.id.endsWith(filter)
    })
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

    // Note: Sessions are NOT auto-restored on startup.
    // Saved credential files are preserved so that when the user clicks "Connect",
    // Baileys can auto-authenticate from saved creds without requiring a new QR scan.
    // But sessions are only created when explicitly requested via the API.
    logger.info('Initialization complete (sessions will be created on demand)');
}

export {
    isSessionExists,
    createSession,
    getSession,
    deleteSession,
    disconnectSession,
    getSessionStatus,
    getChatList,
    isExists,
    sendMessage,
    sendMediaMessage,
    formatPhone,
    formatGroup,
    cleanup,
    init,
}
