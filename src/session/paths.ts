import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export function root(): string {
  return process.env.BB1688_HOME ?? path.join(os.homedir(), '.1688');
}

export function profilesDir(): string {
  return path.join(root(), 'profiles');
}

export function defaultProfileName(profile?: string): string {
  const name = profile?.trim();
  const normalized = name || 'default';
  if (
    !/^[A-Za-z0-9._-]{1,128}$/u.test(normalized)
    || normalized === '.'
    || normalized === '..'
  ) {
    throw new TypeError('Profile name must be a safe local identifier.');
  }
  return normalized;
}

export function profileRuntimeDir(profile?: string): string {
  const name = defaultProfileName(profile);
  return name === 'default' ? root() : profilePath(name);
}

export function stateFile(profile?: string): string {
  return path.join(profileRuntimeDir(profile), 'state.json');
}

export function lockFile(profile?: string): string {
  return path.join(profileRuntimeDir(profile), '.lock');
}

export function socketPath(profile?: string): string {
  return socketPathForPlatform(process.platform, root(), profile);
}

export function socketPathForPlatform(
  platform: NodeJS.Platform,
  rootPath: string,
  profile?: string,
): string {
  const name = defaultProfileName(profile);
  // Windows: Node's net.listen()/createConnection() can't bind a Unix-style
  // filesystem path on win32 (EACCES). Use a named pipe instead. Include a
  // stable root hash so different users and BB1688_HOME values do not collide,
  // and include the profile hash so profiles under one root can run together.
  if (platform === 'win32') {
    const base = `\\\\.\\pipe\\1688-cli-daemon-${rootHash(rootPath)}`;
    return name === 'default' ? base : `${base}-${profileHash(name)}`;
  }
  const dir =
    name === 'default' ? rootPath : path.join(rootPath, 'profiles', name);
  return path.join(dir, 'daemon.sock');
}

export function rootHash(rootPath: string): string {
  return crypto
    .createHash('sha1')
    .update(path.resolve(rootPath).toLowerCase())
    .digest('hex')
    .slice(0, 12);
}

export function profileHash(profile: string): string {
  return crypto
    .createHash('sha1')
    .update(defaultProfileName(profile).toLowerCase())
    .digest('hex')
    .slice(0, 12);
}

export function pidFile(profile?: string): string {
  return path.join(profileRuntimeDir(profile), 'daemon.pid');
}

export function daemonVersionFile(profile?: string): string {
  return path.join(profileRuntimeDir(profile), 'daemon.version');
}

export function daemonLogFile(profile?: string): string {
  return path.join(profileRuntimeDir(profile), 'daemon.log');
}

export function runsDir(): string {
  return path.join(root(), 'runs');
}

export function eventsFile(): string {
  return path.join(root(), 'events.jsonl');
}

export function configFile(): string {
  return path.join(root(), 'config.json');
}

export function loginQrFile(): string {
  return path.join(root(), 'login-qr.png');
}

export function profilePath(name = 'default'): string {
  return path.join(profilesDir(), defaultProfileName(name));
}

export async function ensureRoot(): Promise<void> {
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(root(), 0o700);
}

export async function ensureProfileRuntimeDir(profile?: string): Promise<void> {
  const directory = profileRuntimeDir(profile);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
}
