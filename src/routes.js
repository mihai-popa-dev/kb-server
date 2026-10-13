const { getDb } = require('./database');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SUMMARY_FIELDS = ['id', 'title', 'source', 'namespace', 'tier', 'tags', 'created_at', 'updated_at'];
const WRITABLE_FIELDS = ['title', 'content', 'source', 'namespace', 'tier', 'tags'];

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// FTS snippets carry <mark> tags; escape everything, then restore only those two tags
function snippetHtml(snippet) {
    return escapeHtml(snippet)
        .replace(/&lt;mark&gt;/g, '<mark>')
        .replace(/&lt;\/mark&gt;/g, '</mark>');
}

function summaryColumns(alias) {
    return SUMMARY_FIELDS.map(field => `${alias}.${field}`).join(', ');
}

function formatDocument(row) {
    let tags = [];
    try {
        tags = JSON.parse(row.tags || '[]');
    } catch {
        tags = [];
    }
    return { ...row, tags };
}

function getDocument(id) {
    const row = getDb().prepare('SELECT * FROM documents WHERE id = ?').get(id);
    return row ? formatDocument(row) : null;
}

function parseId(raw) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) {
        throw new HttpError(400, 'id must be a positive integer');
    }
    return id;
}

function parseLimit(raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return DEFAULT_LIMIT;
    return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function parseOffset(raw) {
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) || n < 0 ? 0 : n;
}

// Query-string values can repeat (?tag=a&tag=b); only accept a single string
function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function buildFilters(query, alias) {
    const clauses = [];
    const params = [];
    const namespace = str(query.namespace);
    const tier = str(query.tier);
    const tag = str(query.tag);

    if (namespace) {
        clauses.push(`${alias}.namespace = ?`);
        params.push(namespace);
    }
    if (tier) {
        clauses.push(`${alias}.tier = ?`);
        params.push(tier);
    }
    if (tag) {
        clauses.push(`EXISTS (SELECT 1 FROM json_each(${alias}.tags) WHERE json_each.value = ?)`);
        params.push(tag);
    }
    return { clauses, params };
}

// Each word becomes a quoted FTS5 phrase so user input can never be parsed as FTS syntax
function toFtsQuery(input) {
    return input
        .split(/\s+/)
        .filter(Boolean)
        .map(term => `"${term.replace(/"/g, '""')}"*`)
        .join(' ');
}

function listDocuments(query) {
    const db = getDb();
    const { clauses, params } = buildFilters(query, 'documents');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = parseLimit(query.limit);
    const offset = parseOffset(query.offset);

    const rows = db.prepare(`
        SELECT ${summaryColumns('documents')}
        FROM documents ${where}
        ORDER BY documents.updated_at DESC, documents.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM documents ${where}`).get(...params);

    return { total, limit, offset, documents: rows.map(formatDocument) };
}

function searchDocuments(q, query) {
    const db = getDb();
    const { clauses, params } = buildFilters(query, 'd');
    const limit = parseLimit(query.limit);
    const offset = parseOffset(query.offset);
    const from = `
        FROM documents_fts
        JOIN documents d ON d.id = documents_fts.rowid
        WHERE ${['documents_fts MATCH ?', ...clauses].join(' AND ')}
    `;
    const match = toFtsQuery(q);

    const rows = db.prepare(`
        SELECT ${summaryColumns('d')}, snippet(documents_fts, -1, '<mark>', '</mark>', '…', 24) AS snippet
        ${from}
        ORDER BY bm25(documents_fts)
        LIMIT ? OFFSET ?
    `).all(match, ...params, limit, offset);

    const { total } = db.prepare(`SELECT COUNT(*) AS total ${from}`).get(match, ...params);

    return { total, limit, offset, documents: rows.map(formatDocument) };
}

function listNamespaces() {
    return getDb().prepare(`
        SELECT namespace, COUNT(*) AS count
        FROM documents
        GROUP BY namespace
        ORDER BY namespace
    `).all();
}

// Builds a complete document from the request body, falling back to `current` for missing fields
function validateDocument(body, current = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Request body must be a JSON object');
    }

    const doc = {
        title: current.title,
        content: current.content,
        source: current.source ?? null,
        namespace: current.namespace || 'shared',
        tier: current.tier || 'cold',
        tags: current.tags || [],
    };
    for (const field of WRITABLE_FIELDS) {
        if (body[field] !== undefined) doc[field] = body[field];
    }

    if (typeof doc.title !== 'string' || !doc.title.trim()) {
        throw new HttpError(400, 'title must be a non-empty string');
    }
    if (typeof doc.content !== 'string' || !doc.content.trim()) {
        throw new HttpError(400, 'content must be a non-empty string');
    }
    if (doc.source !== null && typeof doc.source !== 'string') {
        throw new HttpError(400, 'source must be a string or null');
    }
    if (typeof doc.namespace !== 'string' || !doc.namespace.trim()) {
        throw new HttpError(400, 'namespace must be a non-empty string');
    }
    if (typeof doc.tier !== 'string' || !doc.tier.trim()) {
        throw new HttpError(400, 'tier must be a non-empty string');
    }
    if (!Array.isArray(doc.tags) || !doc.tags.every(tag => typeof tag === 'string')) {
        throw new HttpError(400, 'tags must be an array of strings');
    }
    return doc;
}

function storageParams(doc) {
    return {
        title: doc.title,
        content: doc.content,
        source: doc.source,
        namespace: doc.namespace,
        tier: doc.tier,
        tags: JSON.stringify(doc.tags),
    };
}

// ---------- REST API ----------

function setupApi(app) {
    app.get('/api/health', (req, res) => {
        const { count } = getDb().prepare('SELECT COUNT(*) AS count FROM documents').get();
        res.json({ status: 'ok', documents: count });
    });

    app.get('/api/documents', (req, res) => {
        res.json(listDocuments(req.query));
    });

    app.get('/api/documents/:id', (req, res) => {
        const doc = getDocument(parseId(req.params.id));
        if (!doc) throw new HttpError(404, 'Document not found');
        res.json(doc);
    });

    app.post('/api/documents', (req, res) => {
        const doc = validateDocument(req.body);
        const result = getDb().prepare(`
            INSERT INTO documents (title, content, source, namespace, tier, tags)
            VALUES (@title, @content, @source, @namespace, @tier, @tags)
        `).run(storageParams(doc));
        res.status(201).json(getDocument(result.lastInsertRowid));
    });

    app.patch('/api/documents/:id', (req, res) => {
        const id = parseId(req.params.id);
        const existing = getDocument(id);
        if (!existing) throw new HttpError(404, 'Document not found');

        const doc = validateDocument(req.body, existing);
        getDb().prepare(`
            UPDATE documents
            SET title = @title, content = @content, source = @source,
                namespace = @namespace, tier = @tier, tags = @tags,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = @id
        `).run({ ...storageParams(doc), id });
        res.json(getDocument(id));
    });

    app.delete('/api/documents/:id', (req, res) => {
        const id = parseId(req.params.id);
        const result = getDb().prepare('DELETE FROM documents WHERE id = ?').run(id);
        if (result.changes === 0) throw new HttpError(404, 'Document not found');
        res.status(204).end();
    });

    app.get('/api/search', (req, res) => {
        const q = str(req.query.q);
        if (!q) throw new HttpError(400, 'q is required');
        res.json({ query: q, ...searchDocuments(q, req.query) });
    });

    app.get('/api/namespaces', (req, res) => {
        res.json({ namespaces: listNamespaces() });
    });

    app.use('/api', (req, res) => {
        res.status(404).json({ error: 'Not found' });
    });
}

// ---------- Web dashboard ----------

const STYLE = `
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --border: #e7e5e4; --accent: #b45309; --mark: #fde68a; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --border: #44403c; --accent: #fbbf24; --mark: #78350f; }
}
:root[data-theme="dark"] { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --border: #44403c; --accent: #fbbf24; --mark: #78350f; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
header, main { max-width: 960px; margin: 0 auto; padding: 0 16px; box-sizing: border-box; }
header { padding-top: 16px; }
header a { color: var(--fg); font-weight: 600; text-decoration: none; }
main { padding-bottom: 48px; }
a { color: var(--accent); }
form.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
input, select, button { font: inherit; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; min-width: 0; }
input[type="search"] { flex: 1 1 220px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 14px; color: var(--muted); font-weight: 500; }
.muted { color: var(--muted); font-size: 14px; }
.tag { display: inline-block; font-size: 12px; border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; margin: 2px 4px 0 0; color: var(--muted); }
mark { background: var(--mark); color: inherit; border-radius: 2px; }
pre { white-space: pre-wrap; word-wrap: break-word; border: 1px solid var(--border); border-radius: 8px; padding: 16px; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (max-width: 640px) {
  thead { display: none; }
  tr { display: block; border-bottom: 1px solid var(--border); padding: 8px 0; }
  td { display: block; border: 0; padding: 2px 0; }
}
`;

function page(title, body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · KB Server</title>
<style>${STYLE}</style>
</head>
<body>
<header><a href="/">KB Server</a></header>
<main>${body}</main>
</body>
</html>`;
}

function tagList(tags) {
    return tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
}

function namespaceOptions(selected) {
    const options = listNamespaces().map(({ namespace, count }) => {
        const isSelected = namespace === selected ? ' selected' : '';
        return `<option value="${escapeHtml(namespace)}"${isSelected}>${escapeHtml(namespace)} (${count})</option>`;
    });
    return `<option value="">All namespaces</option>${options.join('')}`;
}

function documentTable(documents) {
    if (documents.length === 0) return '<p class="muted">No documents found.</p>';

    const rows = documents.map(doc => {
        const snippet = doc.snippet ? `<div class="muted">${snippetHtml(doc.snippet)}</div>` : '';
        return `<tr>
<td><a href="/docs/${doc.id}">${escapeHtml(doc.title)}</a>${snippet}${tagList(doc.tags)}</td>
<td>${escapeHtml(doc.namespace)}</td>
<td>${escapeHtml(doc.tier)}</td>
<td class="muted">${escapeHtml(doc.updated_at)}</td>
</tr>`;
    });

    return `<table>
<thead><tr><th>Title</th><th>Namespace</th><th>Tier</th><th>Updated</th></tr></thead>
<tbody>${rows.join('')}</tbody>
</table>`;
}

function setupDashboard(app) {
    app.get('/', (req, res) => {
        const q = str(req.query.q);
        const namespace = str(req.query.namespace);
        const filters = { namespace };

        const results = q ? searchDocuments(q, filters) : listDocuments(filters);
        const heading = q
            ? `<p class="muted">${results.total} result${results.total === 1 ? '' : 's'} for “${escapeHtml(q)}”</p>`
            : '<p class="muted">Most recently updated</p>';

        res.send(page('Documents', `
<form class="filters" method="get" action="/">
<input type="search" name="q" value="${escapeHtml(q || '')}" placeholder="Search documents">
<select name="namespace">${namespaceOptions(namespace)}</select>
<button type="submit">Filter</button>
</form>
${heading}
${documentTable(results.documents)}
`));
    });

    app.get('/docs/:id', (req, res) => {
        const doc = getDocument(parseId(req.params.id));
        if (!doc) throw new HttpError(404, 'Document not found');

        const meta = [doc.namespace, doc.tier, doc.source, `created ${doc.created_at}`, `updated ${doc.updated_at}`]
            .filter(Boolean)
            .map(escapeHtml)
            .join(' · ');

        res.send(page(doc.title, `
<p><a href="/">← All documents</a></p>
<h1>${escapeHtml(doc.title)}</h1>
<p class="muted">${meta}</p>
<p>${tagList(doc.tags)}</p>
<pre>${escapeHtml(doc.content)}</pre>
`));
    });
}

// ---------- Error handling ----------

function handleErrors(err, req, res, next) {
    if (res.headersSent) return next(err);

    const status = err.status || err.statusCode || 500;
    const message = status >= 500 ? 'Internal server error' : err.message;
    if (status >= 500) console.error(err);

    if (req.path.startsWith('/api')) {
        return res.status(status).json({ error: message });
    }
    res.status(status).send(page(`Error ${status}`, `<h1>${status}</h1><p class="muted">${escapeHtml(message)}</p>`));
}

function setupRoutes(app) {
    setupApi(app);
    setupDashboard(app);
    app.use(handleErrors);
}

module.exports = { setupRoutes };
