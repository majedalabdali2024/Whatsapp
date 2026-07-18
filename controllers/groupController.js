import { getSession, isExists, sendMessage, formatGroup, fetchParticipatingGroups, resolveGroupInvite } from './../whatsapp.js'
import response from './../response.js'

const getList = async (req, res) => {
    try {
        const groups = await fetchParticipatingGroups(res.locals.sessionId)
        response(res, 200, true, 'Groups loaded.', groups)
    } catch (error) {
        response(res, 500, false, `Failed to fetch groups: ${error.message}`)
    }
}

const resolveInvite = async (req, res) => {
    const raw = req.body.invite || req.body.url || req.body.code || ''
    try {
        const info = await resolveGroupInvite(res.locals.sessionId, raw)
        response(res, 200, true, 'Invite resolved.', info)
    } catch (error) {
        response(res, 400, false, `Unable to resolve invite: ${error.message}`)
    }
}

const send = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const receiver = formatGroup(req.body.receiver)
    const { message } = req.body

    try {
        const exists = await isExists(session, receiver, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await sendMessage(session, receiver, { text: message })

        response(res, 200, true, 'The message has been successfully sent.')
    } catch {
        response(res, 500, false, 'Failed to send the message.')
    }
}

export { getList, resolveInvite, send }
