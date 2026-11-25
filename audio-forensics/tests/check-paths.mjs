import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
const files = execSync('find js -name "*.js"', { encoding: 'utf8' }).trim().split('\n');
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = resolve(dirname(f), m[1]);
    if (!existsSync(target)) { console.log('BROKEN', f, '->', m[1]); bad++; }
  }
}
console.log(bad ? `${bad} broken imports` : 'all relative imports resolve');
process.exit(bad ? 1 : 0);
