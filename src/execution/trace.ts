import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (
    typeof object.name === 'string' &&
    /^(cookie|set-cookie|authorization|proxy-authorization|ld_session)$/i.test(object.name) &&
    'value' in object
  )
    return { ...object, value: '[REDACTED]' };
  return Object.fromEntries(
    Object.entries(object).map(([key, v]) => [key, key === 'cookies' ? [] : sanitize(v)]),
  );
}
export function redactTraceArchive(archive: Uint8Array, secrets: string[]) {
  const zip = unzipSync(archive);
  for (const [name, bytes] of Object.entries(zip)) {
    // Byte replacement also covers request-body resources without corrupting binary assets.
    let data = Buffer.from(bytes);
    for (const secret of secrets.filter(Boolean)) {
      const needle = Buffer.from(secret),
        replacement = Buffer.from('[REDACTED]');
      let index: number,
        offset = 0;
      const parts: Buffer[] = [];
      while ((index = data.indexOf(needle, offset)) >= 0) {
        parts.push(data.subarray(offset, index), replacement);
        offset = index + needle.length;
      }
      parts.push(data.subarray(offset));
      data = Buffer.concat(parts);
    }
    if (/\.(trace|network|stacks)$/.test(name)) {
      zip[name] = strToU8(
        strFromU8(data)
          .split('\n')
          .map((line) => {
            if (!line.trim()) return line;
            try {
              return JSON.stringify(sanitize(JSON.parse(line)));
            } catch {
              throw new Error('Trace JSON could not be safely sanitized.');
            }
          })
          .join('\n'),
      );
    } else zip[name] = data;
  }
  return zipSync(zip);
}
