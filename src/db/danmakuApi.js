function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseTimeParam(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return fallback;
  }
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function queryInt(searchParams, name, fallback, min, max) {
  return clampInt(searchParams.get(name), fallback, min, max);
}

function parseMetadataRows(rows) {
  for (const row of rows) {
    if (row?.metadata_json !== undefined) {
      try {
        row.metadata = JSON.parse(row.metadata_json);
      } catch {
        row.metadata = {};
      }
      delete row.metadata_json;
    }
  }
  return rows;
}

export async function handleDanmakuApi(req, res, pathname, config, repo, log) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: '仅支持 GET' });
    return;
  }

  const database = config.database ?? {};
  const readToken = database.readToken;
  if (readToken) {
    const provided = String(req.headers['x-db-token'] ?? '');
    if (provided !== String(readToken)) {
      sendJson(res, 401, { ok: false, error: '数据库只读接口令牌错误' });
      return;
    }
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams;

  if (pathname === '/db/health') {
    sendJson(res, 200, { ok: true, database: repo.getStats() });
    return;
  }

  if (!repo.enabled) {
    sendJson(res, 503, {
      ok: false,
      error: '弹幕数据库未启用',
      reason: repo.failureReason ?? 'unknown',
    });
    return;
  }

  try {
    if (pathname === '/db/danmaku') {
      const filters = {
        fromMs: parseTimeParam(q.get('from')),
        toMs: parseTimeParam(q.get('to')),
        uid: q.get('uid'),
        username: q.get('username'),
        text: q.get('text'),
        role: q.get('role'),
        status: q.get('status'),
        limit: queryInt(q, 'limit', 50, 1, 200),
        offset: queryInt(q, 'offset', 0, 0, 1000000),
      };
      const result = repo.queryDanmaku(filters);
      sendJson(res, 200, { ok: true, ...result, rows: parseMetadataRows(result.rows) });
      return;
    }

    if (pathname === '/db/hot') {
      const hotPhrase = config.hotPhrase ?? {};
      const minutes = queryInt(q, 'minutes', Number(hotPhrase.windowMinutes) || 10, 1, 1440);
      const windowEndMs = Date.now();
      const windowStartMs = windowEndMs - minutes * 60 * 1000;
      const rows = repo.getHot({
        windowStartMs,
        windowEndMs,
        minCount: queryInt(q, 'minCount', Number(hotPhrase.minCount) || 3, 1, 100000),
        minTextLength: queryInt(q, 'minLength', Number(hotPhrase.minTextLength) || 2, 1, 1000),
        maxTextLength: queryInt(q, 'maxLength', Number(hotPhrase.maxTextLength) || 120, 1, 10000),
        limit: queryInt(q, 'limit', 20, 1, 200),
      });
      sendJson(res, 200, {
        ok: true,
        windowMinutes: minutes,
        windowStartMs,
        windowEndMs,
        rows,
      });
      return;
    }

    const userMatch = pathname.match(/^\/db\/users\/(\d+)$/);
    if (userMatch) {
      const result = repo.getUserTimeline(Number(userMatch[1]), {
        limit: queryInt(q, 'limit', 50, 1, 200),
        offset: queryInt(q, 'offset', 0, 0, 1000000),
      });
      sendJson(res, 200, { ok: true, ...result, rows: parseMetadataRows(result.rows) });
      return;
    }

    if (pathname === '/db/users') {
      const result = repo.listUsers({
        limit: queryInt(q, 'limit', 50, 1, 200),
        offset: queryInt(q, 'offset', 0, 0, 1000000),
      });
      sendJson(res, 200, { ok: true, ...result, rows: parseMetadataRows(result.rows) });
      return;
    }

    if (pathname === '/db/sessions') {
      sendJson(res, 200, {
        ok: true,
        rows: parseMetadataRows(repo.listSessions(queryInt(q, 'limit', 10, 1, 100))),
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: '数据库接口不存在' });
  } catch (err) {
    log('error', `弹幕数据库查询失败: ${err.message}`);
    sendJson(res, 500, { ok: false, error: err.message });
  }
}
