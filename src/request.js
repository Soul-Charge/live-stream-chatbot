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

  const maxLength = Number(cfg.maxTextLength) || 0;
  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  for (const [from, to] of Object.entries(cfg.replacements ?? {})) {
    if (from) text = text.split(from).join(String(to));
  }

  const result = text.trim();
  if (!result) throw new RequestError(400, '清洗后文本为空');
  return result;
}

export function matchRole(name, text, roles, roleHint) {
  const table = roles ?? {};
  if (roleHint && table[roleHint]) {
    return { roleName: roleHint, role: table[roleHint] };
  }

  const entries = Object.entries(table).filter(([key]) => key !== 'default');
  const keywordsOf = (role) => (Array.isArray(role?.keywords) ? role.keywords : []);
  const findMatch = (haystack) =>
    entries.find(([, role]) =>
      keywordsOf(role).some((keyword) => keyword && haystack.includes(keyword)),
    );

  const matched = (name ? findMatch(String(name)) : undefined) ?? (text ? findMatch(String(text)) : undefined);
  if (matched) {
    return { roleName: matched[0], role: matched[1] };
  }
  return { roleName: 'default', role: table.default ?? null };
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
