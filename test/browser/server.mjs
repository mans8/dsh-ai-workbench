/**
 * AI 工作台账 — 真实浏览器复现服务器。
 *
 * 把插件的 **Host 半体**（index.js + lib/）真的挂在 HTTP 上，
 * 再把 **Client 半体**（client.js）交给一个真实浏览器里的真 React 去执行。
 *
 * 这一套是用来抓「真机白屏」这类问题的：mini-React 垫片测不出 React 的真实行为，
 * 也用不上真实的 DOM。第一次跑通它就抓到了 `api` 少暴露 getSnapshot/subscribe
 * 导致整页空白 —— 那个 bug 在单元测试里是全绿的。
 *
 * 用法：
 *   cd test/browser
 *   npm install --no-save react@19 react-dom@19 esbuild   # 一次性
 *   node build.mjs                                        # 产出 site/bundle.js
 *   node server.mjs --reset                               # 起服务（默认 http://127.0.0.1:8791）
 *   然后用浏览器打开，或交给 ego-browser 之类的工具去点。
 *
 * 状态落在 `test/browser/.state/`，`--reset` 会先清空。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..', '..');
const SITE = join(HERE, 'site');
const HOME = join(HERE, '.state');
const PORT = Number(process.env.AW_PORT ?? 8791);

if (process.argv.includes('--reset') && existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });
process.env.AI_WORKBENCH_STATE_FILE = join(HOME, 'state.json');
process.env.DSH_HOME = HOME;

/** 伪造 Cordis 上下文，只保留路由与工具注册。 */
const routes = new Map();
const tools = new Map();
const mod = await import(join(PLUGIN_DIR, 'index.js'));
mod.apply(
  {
    effect: (fn) => fn(),
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => {};
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => {};
      },
    },
  },
  {},
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 插件的真实 HTTP 路由
  if (url.pathname === '/ai-workbench/api') {
    const route = routes.get('/ai-workbench/api');
    if (!route) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('插件路由未注册');
      return;
    }
    return route.handler(req, res);
  }

  // 插件真实的 client.js（浏览器里由 __ModuleLoader__ 接收）
  if (url.pathname === '/ai-workbench-client.js') {
    const body = await readFile(join(PLUGIN_DIR, 'client.js'));
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    return res.end(body);
  }

  const file = url.pathname === '/' ? join(SITE, 'index.html') : join(SITE, url.pathname.replace(/^\//, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[AI 工作台账复现] http://127.0.0.1:${PORT}/`);
  console.log(`  插件 API : /ai-workbench/api`);
  console.log(`  状态文件 : ${join(HOME, 'ai-workbench', 'state.json')}`);
  console.log(`  已注册工具: ${Array.from(tools.keys()).join(', ')}`);
});
