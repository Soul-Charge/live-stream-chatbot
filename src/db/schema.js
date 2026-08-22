export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE live_sessions (
        id             INTEGER PRIMARY KEY,
        started_at_ms  INTEGER NOT NULL,
        ended_at_ms    INTEGER,
        room_id        TEXT,
        title          TEXT,
        metadata_json  TEXT NOT NULL DEFAULT '{}'
      )`,

      `CREATE TABLE users (
        id              INTEGER PRIMARY KEY,
        user_key        TEXT NOT NULL UNIQUE,
        uid             TEXT,
        username        TEXT NOT NULL,
        first_seen_at_ms INTEGER NOT NULL,
        last_seen_at_ms  INTEGER NOT NULL,
        message_count   INTEGER NOT NULL DEFAULT 0,
        metadata_json   TEXT NOT NULL DEFAULT '{}'
      )`,

      `CREATE TABLE danmaku (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     INTEGER REFERENCES live_sessions(id),
        received_at_ms INTEGER NOT NULL,
        user_id        INTEGER NOT NULL REFERENCES users(id),
        uid            TEXT,
        username       TEXT NOT NULL,
        raw_text       TEXT NOT NULL,
        clean_text     TEXT NOT NULL,
        speech_text    TEXT NOT NULL,
        text_len       INTEGER NOT NULL,
        speech_hash    TEXT NOT NULL,
        role_key       TEXT NOT NULL,
        role_comment   TEXT,
        accepted       INTEGER NOT NULL DEFAULT 1,
        reject_reason  TEXT,
        tts_status     TEXT NOT NULL DEFAULT 'accepted'
                       CHECK (tts_status IN ('accepted','queued','synthesizing','played','cache_hit','disk_cache_hit','skipped','error')),
        used_cache     INTEGER NOT NULL DEFAULT 0,
        tts_error      TEXT,
        cache_key      TEXT,
        metadata_json  TEXT NOT NULL DEFAULT '{}'
      )`,

      `CREATE TABLE tts_audio_cache (
        cache_key          TEXT PRIMARY KEY,
        role_key           TEXT NOT NULL,
        speech_text        TEXT NOT NULL,
        speech_hash        TEXT NOT NULL,
        file_path          TEXT NOT NULL,
        media_type         TEXT NOT NULL DEFAULT 'wav',
        duration_ms        INTEGER,
        size_bytes         INTEGER NOT NULL,
        first_created_at_ms INTEGER NOT NULL,
        last_hit_at_ms     INTEGER,
        hit_count          INTEGER NOT NULL DEFAULT 0,
        source             TEXT NOT NULL DEFAULT 'request'
                           CHECK (source IN ('request','hot_pregen','manual')),
        metadata_json      TEXT NOT NULL DEFAULT '{}',
        UNIQUE (role_key, speech_hash)
      )`,

      `CREATE TABLE hot_phrase_jobs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        window_start_ms INTEGER NOT NULL,
        window_end_ms   INTEGER NOT NULL,
        role_key        TEXT NOT NULL,
        speech_text     TEXT NOT NULL,
        speech_hash     TEXT NOT NULL,
        count           INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','done','skipped','error')),
        cache_key       TEXT,
        error           TEXT,
        created_at_ms   INTEGER NOT NULL,
        completed_at_ms INTEGER
      )`,

      `CREATE INDEX idx_sessions_started ON live_sessions(started_at_ms)`,
      `CREATE INDEX idx_danmaku_time ON danmaku(received_at_ms)`,
      `CREATE INDEX idx_danmaku_user_time ON danmaku(user_id, received_at_ms)`,
      `CREATE INDEX idx_danmaku_role_time ON danmaku(role_key, received_at_ms)`,
      `CREATE INDEX idx_danmaku_status ON danmaku(tts_status, received_at_ms)`,
      `CREATE INDEX idx_danmaku_hot ON danmaku(role_key, speech_hash, received_at_ms)`,
      `CREATE INDEX idx_hot_jobs_window ON hot_phrase_jobs(window_end_ms, status)`,
      `CREATE INDEX idx_cache_role_hash ON tts_audio_cache(role_key, speech_hash)`,
    ],
  },
];
