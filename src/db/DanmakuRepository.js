import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

import { openDanmakuDatabase } from './connection.js';
import { migrateDanmakuDatabase } from './migrate.js';

function json(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function clampInt(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

class DisabledDanmakuRepository {
  enabled = false;
  failureReason;

  constructor(reason) {
    this.failureReason = reason;
  }

  insert() { return null; }
  updateTtsStatus() {}
  getStats() { return { enabled: false }; }
  queryDanmaku() { return { rows: [], total: 0 }; }
  getHot() { return []; }
  listUsers() { return { rows: [], total: 0 }; }
  getUserTimeline() { return { rows: [], total: 0 }; }
  listSessions() { return []; }
  close() {}
}

export class DanmakuRepository {
  #db;
  #log;
  #sessionId = null;
  #roomId;
  #sessionTitle;
  #insertUserStmt;
  #insertSessionStmt;
  #insertDanmakuStmt;
  #updateStatusStmt;
  #insertTransaction;

  constructor(db, config, log = () => {}) {
    this.#db = db;
    this.#log = log;
    this.#roomId = config.roomId || null;
    this.#sessionTitle = config.sessionTitle || 'live-stream-chatbot';

    this.#insertUserStmt = db.prepare(`
      INSERT INTO users (
        user_key, uid, username, first_seen_at_ms, last_seen_at_ms, message_count
      ) VALUES (@userKey, @uid, @username, @now, @now, 1)
      ON CONFLICT(user_key) DO UPDATE SET
        uid = COALESCE(excluded.uid, users.uid),
        username = excluded.username,
        last_seen_at_ms = excluded.last_seen_at_ms,
        message_count = users.message_count + 1
      RETURNING id
    `);

    this.#insertSessionStmt = db.prepare(`
      INSERT INTO live_sessions (started_at_ms, ended_at_ms, room_id, title, metadata_json)
      VALUES (@now, NULL, @roomId, @title, '{}')
      RETURNING id
    `);

    this.#insertDanmakuStmt = db.prepare(`
      INSERT INTO danmaku (
        session_id, received_at_ms, user_id, uid, username,
        raw_text, clean_text, speech_text, text_len, speech_hash,
        role_key, role_comment, accepted, reject_reason, tts_status,
        used_cache, tts_error, cache_key, metadata_json
      ) VALUES (
        @sessionId, @now, @userId, @uid, @username,
        @rawText, @cleanText, @speechText, @textLen, @speechHash,
        @roleKey, @roleComment, @accepted, @rejectReason, @ttsStatus,
        @usedCache, @ttsError, @cacheKey, @metadataJson
      )
      RETURNING id
    `);

    this.#updateStatusStmt = db.prepare(`
      UPDATE danmaku
      SET tts_status = @status,
          tts_error = @error,
          cache_key = COALESCE(@cacheKey, cache_key),
          used_cache = CASE WHEN @usedCache = 1 THEN 1 ELSE used_cache END
      WHERE id = @id
    `);

    this.#insertTransaction = db.transaction((record) => this.#insert(record));
  }

  get enabled() {
    return true;
  }

  #ensureSession(now) {
    if (this.#sessionId !== null) return this.#sessionId;
    const row = this.#insertSessionStmt.get({
      now,
      roomId: this.#roomId,
      title: this.#sessionTitle,
    });
    this.#sessionId = Number(row.id);
    return this.#sessionId;
  }

  #upsertUser({ uid, username, now }) {
    const normalizedName = String(username || '匿名用户');
    const normalizedUid = uid ? String(uid) : null;
    const userKey = normalizedUid ? `uid:${normalizedUid}` : `name:${normalizedName}`;
    const row = this.#insertUserStmt.get({
      userKey,
      uid: normalizedUid,
      username: normalizedName,
      now,
    });
    return Number(row.id);
  }

  #insert(record) {
    const now = Number(record.receivedAtMs) || Date.now();
    const accepted = record.accepted === false ? 0 : 1;
    const rawText = String(record.rawText ?? '');
    const cleanText = String(record.cleanText ?? '');
    const speechText = String(record.speechText ?? '');
    const roleKey = String(record.roleKey ?? 'default');
    const cacheKey = record.cacheKey || (accepted ? `${roleKey}\n${speechText}` : null);

    const userId = this.#upsertUser({
      uid: record.uid ?? null,
      username: record.username ?? '',
      now,
    });
    const sessionId = this.#ensureSession(now);

    const row = this.#insertDanmakuStmt.get({
      sessionId,
      now,
      userId,
      uid: record.uid ? String(record.uid) : null,
      username: String(record.username || '匿名用户'),
      rawText,
      cleanText,
      speechText,
      textLen: Number(record.textLen) || speechText.length,
      speechHash: createHash('sha1').update(speechText, 'utf8').digest('hex'),
      roleKey,
      roleComment: record.roleComment ? String(record.roleComment) : null,
      accepted,
      rejectReason: accepted ? null : String(record.rejectReason || ''),
      ttsStatus: String(record.ttsStatus || (accepted ? 'accepted' : 'skipped')),
      usedCache: record.usedCache ? 1 : 0,
      ttsError: record.ttsError ? String(record.ttsError) : null,
      cacheKey,
      metadataJson: json(record.metadata),
    });

    return Number(row.id);
  }

  insert(record) {
    return this.#insertTransaction(record);
  }

  updateTtsStatus(id, update = {}) {
    if (!id) return;
    this.#updateStatusStmt.run({
      id: Number(id),
      status: String(update.status || 'error'),
      error: update.error ? String(update.error) : null,
      cacheKey: update.cacheKey || null,
      usedCache: update.usedCache ? 1 : 0,
    });
  }

  getStats() {
    const summary = this.#db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(accepted), 0) AS accepted,
        COALESCE(SUM(CASE WHEN accepted = 0 THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN tts_status = 'error' THEN 1 ELSE 0 END), 0) AS ttsErrors,
        COALESCE(MAX(received_at_ms), 0) AS lastReceivedAtMs
      FROM danmaku
    `).get();

    const byStatus = this.#db.prepare(`
      SELECT tts_status AS status, COUNT(*) AS count
      FROM danmaku GROUP BY tts_status ORDER BY count DESC
    `).all();

    let fileSizeBytes = 0;
    try {
      fileSizeBytes = statSync(this.#db.name).size;
    } catch {
      // 数据库文件可能尚未落盘
    }

    return {
      enabled: true,
      path: this.#db.name,
      fileSizeBytes,
      ...summary,
      byStatus,
    };
  }

  queryDanmaku(filters = {}) {
    const clauses = [];
    const params = {};
    const add = (sql, key, value) => {
      clauses.push(sql);
      params[key] = value;
    };

    if (filters.fromMs) add('received_at_ms >= @fromMs', 'fromMs', Number(filters.fromMs));
    if (filters.toMs) add('received_at_ms < @toMs', 'toMs', Number(filters.toMs));
    if (filters.uid) add('uid = @uid', 'uid', String(filters.uid));
    if (filters.username) add('instr(lower(username), lower(@username)) > 0', 'username', String(filters.username));
    if (filters.text) add('instr(lower(speech_text), lower(@text)) > 0', 'text', String(filters.text));
    if (filters.role) add('role_key = @role', 'role', String(filters.role));
    if (filters.status) add('tts_status = @status', 'status', String(filters.status));

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampInt(filters.limit, 50, 1, 200);
    const offset = clampInt(filters.offset, 0, 0, 1000000);

    const rows = this.#db.prepare(`
      SELECT id, session_id, received_at_ms, user_id, uid, username,
             raw_text, clean_text, speech_text, text_len, role_key, role_comment,
             accepted, reject_reason, tts_status, used_cache, tts_error, cache_key,
             metadata_json
      FROM danmaku
      ${where}
      ORDER BY received_at_ms DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const total = this.#db.prepare(`
      SELECT COUNT(*) AS count FROM danmaku ${where}
    `).get(params).count;

    return { rows, total: Number(total) };
  }

  getHot({ windowStartMs, windowEndMs, minCount = 3, minTextLength = 2, maxTextLength = 120, limit = 20 } = {}) {
    return this.#db.prepare(`
      SELECT
        role_key,
        speech_text,
        speech_hash,
        COUNT(*) AS count,
        MIN(received_at_ms) AS first_seen_at_ms,
        MAX(received_at_ms) AS last_seen_at_ms
      FROM danmaku
      WHERE received_at_ms >= @windowStartMs
        AND received_at_ms < @windowEndMs
        AND accepted = 1
        AND text_len BETWEEN @minTextLength AND @maxTextLength
      GROUP BY role_key, speech_hash
      HAVING COUNT(*) >= @minCount
      ORDER BY count DESC, last_seen_at_ms DESC
      LIMIT @limit
    `).all({
      windowStartMs: Number(windowStartMs),
      windowEndMs: Number(windowEndMs),
      minCount: clampInt(minCount, 3, 1, 100000),
      minTextLength: clampInt(minTextLength, 1, 1, 1000),
      maxTextLength: clampInt(maxTextLength, 120, 1, 10000),
      limit: clampInt(limit, 20, 1, 200),
    });
  }

  listUsers({ limit = 50, offset = 0 } = {}) {
    const safeLimit = clampInt(limit, 50, 1, 200);
    const safeOffset = clampInt(offset, 0, 0, 1000000);
    const rows = this.#db.prepare(`
      SELECT id, user_key, uid, username, first_seen_at_ms, last_seen_at_ms,
             message_count, metadata_json
      FROM users
      ORDER BY message_count DESC, last_seen_at_ms DESC
      LIMIT @limit OFFSET @offset
    `).all({ limit: safeLimit, offset: safeOffset });
    const total = this.#db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    return { rows, total: Number(total) };
  }

  getUserTimeline(userId, { limit = 50, offset = 0 } = {}) {
    const safeLimit = clampInt(limit, 50, 1, 200);
    const safeOffset = clampInt(offset, 0, 0, 1000000);
    const rows = this.#db.prepare(`
      SELECT d.id, d.session_id, d.received_at_ms, d.uid, d.username,
             d.raw_text, d.clean_text, d.speech_text, d.text_len,
             d.role_key, d.role_comment, d.accepted, d.reject_reason,
             d.tts_status, d.used_cache, d.tts_error, d.metadata_json
      FROM danmaku d
      WHERE d.user_id = @userId
      ORDER BY d.received_at_ms DESC, d.id DESC
      LIMIT @limit OFFSET @offset
    `).all({ userId: Number(userId), limit: safeLimit, offset: safeOffset });
    const total = this.#db.prepare(
      'SELECT COUNT(*) AS count FROM danmaku WHERE user_id = ?',
    ).get(Number(userId)).count;
    return { rows, total: Number(total) };
  }

  deleteBefore(cutoffMs) {
    const cutoff = Number(cutoffMs);
    if (!Number.isFinite(cutoff)) return 0;

    const selectBatch = this.#db.prepare(`
      SELECT id FROM danmaku
      WHERE received_at_ms < ?
      ORDER BY received_at_ms ASC
      LIMIT 1000
    `);
    let deleted = 0;
    for (;;) {
      const rows = selectBatch.all(cutoff);
      if (rows.length === 0) break;
      const placeholders = rows.map(() => '?').join(',');
      const result = this.#db.prepare(
        `DELETE FROM danmaku WHERE id IN (${placeholders})`,
      ).run(...rows.map((row) => row.id));
      deleted += result.changes;
    }
    return deleted;
  }

  listSessions(limit = 10) {
    return this.#db.prepare(`
      SELECT id, started_at_ms, ended_at_ms, room_id, title, metadata_json
      FROM live_sessions
      ORDER BY started_at_ms DESC
      LIMIT ?
    `).all(clampInt(limit, 10, 1, 100));
  }

  close() {
    try {
      if (this.#sessionId !== null) {
        this.#db.prepare('UPDATE live_sessions SET ended_at_ms = ? WHERE id = ?')
          .run(Date.now(), this.#sessionId);
      }
    } catch (err) {
      this.#log('warn', `关闭弹幕数据库场次失败: ${err.message}`);
    }
    try {
      this.#db.close();
    } catch {
      // 已关闭
    }
  }
}

export function openDanmakuRepository(config, log = () => {}) {
  const dbConfig = config.database ?? {};
  if (dbConfig.enabled === false) {
    return new DisabledDanmakuRepository('disabled by config');
  }

  try {
    const db = openDanmakuDatabase(dbConfig, log);
    migrateDanmakuDatabase(db, log);
    return new DanmakuRepository(db, dbConfig, log);
  } catch (err) {
    log('error', `弹幕数据库初始化失败，已降级为不采集: ${err.message}`);
    return new DisabledDanmakuRepository(err.message);
  }
}
