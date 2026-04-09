import { isSessionExists, createSession, getSession, deleteSession, disconnectSession, getSessionStatus } from './../whatsapp.js'
import response from './../response.js'

const find = (req, res) => {
    if (isSessionExists(req.params.id)) {
        return response(res, 200, true, 'Session found.')
    }

    response(res, 404, false, 'Session not found.')
}

const status = (req, res) => {
    const { id } = req.params
    const info = getSessionStatus(id)

    if (!info) {
        return response(res, 404, false, 'Session not found.', { connected: false })
    }

    response(res, 200, true, 'Session status.', info)
}

const add = async (req, res) => {
    const { id, isLegacy } = req.body

    if (isSessionExists(id)) {
        return response(res, 409, false, 'Session already exists, please use another id.')
    }

    try {
        await createSession(id, isLegacy === 'true', res)
    } catch (error) {
        console.error(`Failed to create session ${id}:`, error.message)
        if (!res.headersSent) {
            response(res, 500, false, `Failed to create session: ${error.message}`)
        }
    }
}

const disconnect = async (req, res) => {
    const { id } = req.params

    if (!isSessionExists(id)) {
        return response(res, 404, false, 'Session not found.')
    }

    await disconnectSession(id)
    response(res, 200, true, 'Session disconnected (auth preserved).')
}

const del = async (req, res) => {
    const { id } = req.params
    const session = getSession(id)

    if (session) {
        try {
            await session.logout()
        } catch {
        } finally {
            deleteSession(id, session.isLegacy)
        }
    } else {
        // Session not in memory - try deleting files for both legacy and non-legacy
        deleteSession(id, false)
        deleteSession(id, true)
    }

    response(res, 200, true, 'The session has been successfully deleted.')
}

export { find, status, add, disconnect, del }
