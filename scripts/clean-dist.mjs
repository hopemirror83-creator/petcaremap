import { rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const target = path.resolve(ROOT, 'dist');

if (!target.startsWith(ROOT)) {
  throw new Error(`Refusing to remove a path outside the project: ${target}`);
}

await rm(target, { recursive: true, force: true });
console.log('Cleaned dist');
