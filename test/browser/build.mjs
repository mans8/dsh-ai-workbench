/**
 * 把 entry.js 打成浏览器能直接跑的 bundle（含真 React）。
 * 用法：node build.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('缺少 esbuild。先在 test/browser 下执行：');
  console.error('  npm install --no-save react@19 react-dom@19 esbuild');
  process.exit(1);
}

await esbuild.build({
  entryPoints: [join(HERE, 'entry.js')],
  bundle: true,
  outfile: join(HERE, 'site', 'bundle.js'),
  format: 'iife',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: 'info',
});
console.log('已产出 site/bundle.js');
