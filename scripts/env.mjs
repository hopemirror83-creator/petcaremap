import { readFileSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(root = process.cwd()) {
  const file = path.join(root, '.env');
  try {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim().replace(/^\uFEFF/, '');
      const value = trimmed.slice(index + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env is optional.
  }
}
