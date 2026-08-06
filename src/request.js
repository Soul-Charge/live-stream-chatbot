export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new RequestError(413, `请求体超过 ${maxBytes} 字节限制`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => {
      reject(new RequestError(400, `读取请求体失败: ${err.message}`));
    });
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyReplacement(text, from, entry) {
  if (!from) return text;
  const descriptor = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  const to = descriptor ? String(descriptor.value ?? '') : String(entry ?? '');
  if (descriptor && descriptor.caseSensitive === false) {
    return text.replace(new RegExp(escapeRegExp(from), 'gi'), () => to);
  }
  return text.split(from).join(to);
}

function normalizeForMatch(value) {
  return String(value ?? '');
}

function matchesStart(text, match, caseSensitive) {
  const haystack = caseSensitive === false ? text.toLowerCase() : text;
  const needle = caseSensitive === false ? normalizeForMatch(match).toLowerCase() : normalizeForMatch(match);
  return needle && haystack.startsWith(needle);
}

function containsMatch(text, match, caseSensitive) {
  const haystack = caseSensitive === false ? text.toLowerCase() : text;
  const needle = caseSensitive === false ? normalizeForMatch(match).toLowerCase() : normalizeForMatch(match);
  return needle && haystack.includes(needle);
}

function applyFilters(text, textConfig) {
  for (const filter of textConfig?.startFilters ?? []) {
    const match = filter?.match ?? filter;
    if (matchesStart(text, match, filter?.caseSensitive)) {
      throw new RequestError(403, '文本包含屏蔽内容');
    }
  }

  const entrance = textConfig?.entranceFilter;
  if (entrance?.prefix && Array.isArray(entrance.keywords)) {
    if (matchesStart(text, entrance.prefix, entrance.caseSensitive)) {
      const hit = entrance.keywords.some((keyword) => containsMatch(text, keyword, entrance.caseSensitive));
      if (hit) throw new RequestError(403, '文本包含屏蔽内容');
    }
  }
}

export function cleanText(rawText, textConfig) {
  const cfg = textConfig ?? {};
  let text = String(rawText ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  const blockedWords = Array.isArray(cfg.blockedWords) ? cfg.blockedWords : [];
  const hit = blockedWords.find((word) => word && text.includes(word));
  if (hit) {
    if (cfg.blockedMode === 'strip') {
      for (const word of blockedWords) {
        if (word) text = text.split(word).join('');
      }
    } else {
      throw new RequestError(403, `文本包含屏蔽词: ${hit}`);
    }
  }

  applyFilters(text, cfg);

  const maxLength = Number(cfg.maxTextLength) || 0;
  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  for (const [from, entry] of Object.entries(cfg.replacements ?? {})) {
    text = applyReplacement(text, from, entry);
  }

  const result = text.trim();
  if (!result) throw new RequestError(400, '清洗后文本为空');
  return result;
}

function roleAliases(role, key) {
  const aliases = [key];
  if (role?.comment) aliases.push(String(role.comment));
  for (const keyword of Array.isArray(role?.keywords) ? role.keywords : []) {
    if (keyword) aliases.push(String(keyword));
  }
  return [...new Set(aliases.filter(Boolean))];
}

function matchRoleFromText(text, roles) {
  const table = roles ?? {};
  const raw = String(text ?? '');
  const head = raw
    .replace(/^[\s\uFEFF\u200B\u2060「『【［(（:：,，.。]+/, '')
    .replace(/\s+/g, '');
  const normalizedHead = head.toLowerCase();
  const candidates = [];

  for (const [key, role] of Object.entries(table)) {
    for (const alias of roleAliases(role, key)) {
      const marker = `${alias}说`;
      // 只检查弹幕开头的“角色名说”，避免文本中其他角色名再次触发模型切换
      if (normalizedHead.startsWith(marker.toLowerCase())) {
        candidates.push({ key, role, alias });
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.alias.length - a.alias.length);
    const best = candidates[0];
    return {
      roleName: best.key,
      role: best.role,
      text: raw,
    };
  }

  return {
    roleName: 'default',
    role: table.default ?? null,
    text: raw,
  };
}

export function matchRole(text, roles, roleHint) {
  const table = roles ?? {};
  if (roleHint && table[roleHint]) {
    const matched = matchRoleFromText(text, { [roleHint]: table[roleHint] });
    return {
      roleName: roleHint,
      role: table[roleHint],
      text: matched.text,
    };
  }
  return matchRoleFromText(text, table);
}

export async function parseRequest(req, config) {
  const serverCfg = config.server ?? {};
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = Object.fromEntries(url.searchParams.entries());
  const method = (req.method ?? 'GET').toUpperCase();

  let bodyText = '';
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    bodyText = await readBody(req, Number(serverCfg.maxBodyBytes) || 16 * 1024);
  }

  let input = null;
  if (bodyText.trim()) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      try {
        input = JSON.parse(bodyText);
      } catch {
        throw new RequestError(400, '请求体不是合法 JSON');
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      input = Object.fromEntries(new URLSearchParams(bodyText));
    } else {
      input = bodyText;
    }
  }

  if (typeof input === 'string') input = { text: input };
  if (!input || typeof input !== 'object') input = {};

  const text = input.text ?? input.msg ?? query.text ?? query.msg ?? '';
  const name = input.name ?? input.user ?? query.name ?? query.user ?? '';
  const roleHint = input.role ?? query.role ?? '';

  return {
    text: cleanText(text, config.text ?? {}),
    name: String(name).trim(),
    roleHint: String(roleHint).trim(),
  };
}
