exports.paging = (req, defLimit = 50, max = 200) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defLimit, 1), max);
    return { page, limit, offset: (page - 1) * limit };
};

exports.meta = (page, limit, total) => ({ page, limit, total, pages: Math.ceil(total / limit) });
