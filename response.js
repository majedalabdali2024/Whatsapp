const response = (res, statusCode = 200, success = false, message = '', data = {}) => {
    res.status(statusCode)
    // res.json() يُنهي الاستجابة؛ لا تستدعِ res.end() بعدها (قد يسبب أخطاء أو فشل فحوصات الصحة)
    res.json({
        success,
        message,
        data,
    })
}

export default response
