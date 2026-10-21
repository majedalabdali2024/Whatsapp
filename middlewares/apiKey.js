import { timingSafeEqual } from 'crypto'
import response from './../response.js'
import logger from './../logger.js'

/**
 * حماية الواجهة بمفتاح سري.
 * - يُفعَّل فقط عند ضبط API_KEY في متغيرات البيئة، فلا يتعطل أي نظام قديم يستخدم الخدمة قبل تحديثه.
 * - يقبل المفتاح في الترويسة x-api-key أو Authorization: Bearer <key>.
 * - مسار /health مستثنى لفحص الصحة على Railway.
 */
const API_KEY = process.env.API_KEY ?? ''

if (!API_KEY) {
    logger.warn('API_KEY is not set: the API is open to anyone who knows its URL. Set API_KEY to protect it.')
}

const safeEqual = (a, b) => {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
}

const apiKey = (req, res, next) => {
    if (!API_KEY || req.path === '/health') {
        return next()
    }

    const header = req.get('x-api-key') ?? ''
    const bearer = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const provided = header || bearer

    if (provided && safeEqual(provided, API_KEY)) {
        return next()
    }

    logger.warn('Rejected request with missing or invalid API key', { path: req.path, ip: req.ip })
    return response(res, 401, false, 'Unauthorized.')
}

export default apiKey
