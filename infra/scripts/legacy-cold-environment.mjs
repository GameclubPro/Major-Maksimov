// FLAG: The captured environment may include independent hold-control authority.
// Validate it before selecting the smaller environment for each cold-client phase.
export function isLegacyColdStoreEnvironment(environment) {
  if (
    typeof environment !== 'string' ||
    Buffer.byteLength(environment) > 16 * 1024 ||
    /[\r\0]/u.test(environment)
  )
    return false;
  const match =
    /^DATABASE_URL=\S+\nREDIS_URL=\S+\n(?:ERASER_CONTROL_URL=(\S+)\nERASER_CONTROL_TOKEN=(\S{32,512})\n)?$/u.exec(
      environment,
    );
  if (!match) return false;
  if (!match[1]) return true;
  try {
    const url = new URL(match[1]);
    return (
      url.origin === 'http://eraser:3000' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function parseLegacyColdStoreEnvironment(environment) {
  if (!isLegacyColdStoreEnvironment(environment)) throw new Error('store_environment_unproved');
  return Object.fromEntries(
    environment
      .trimEnd()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

// FLAG: Copy only the store credentials and optional independent hold control
// from the exact admin generation. MAX bot tokens never enter this boundary.
export function legacyColdStoreEnvironment(environment) {
  if (!Array.isArray(environment)) throw new Error('store_environment_unproved');
  const field = (key) => {
    const matches = environment.filter(
      (entry) => typeof entry === 'string' && entry.startsWith(`${key}=`),
    );
    if (matches.length > 1) throw new Error('store_environment_unproved');
    return matches[0]?.slice(key.length + 1);
  };
  const values = ['DATABASE_URL', 'REDIS_URL'].map((key) => `${key}=${field(key) ?? ''}`);
  const token = field('ERASER_CONTROL_TOKEN');
  const url = field('ERASER_CONTROL_URL');
  if (token) values.push(`ERASER_CONTROL_URL=${url ?? ''}`, `ERASER_CONTROL_TOKEN=${token}`);
  const result = `${values.join('\n')}\n`;
  if (!isLegacyColdStoreEnvironment(result)) throw new Error('store_environment_unproved');
  return result;
}
