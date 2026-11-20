# 真实浏览器复现环境

这不是常规单元测试，而是**排查真机问题的最后一道工具**：把插件的 Host 半体真的挂在 HTTP 上，
再把 Client 半体交给**真实浏览器 + 真 React + 真 DOM** 去跑。

## 为什么需要它

第一版 `client.js` 少给面板暴露了 `getSnapshot` / `subscribe` 两个方法，
结果在真机上**一打开就是白屏**。而当时的单元测试是全绿的 —— 因为测试里的假 `api`
是照着「我以为面板需要什么」手写的，恰好补齐了那两个方法。

**教训**：凡是「主机和客户端之间的契约」，都必须用**真实的那一份**去验证。
现在 `test/client.test.mjs` 里专门有一组 `1b. 面板与插件之间的 api 契约（白屏回归）`，
用 `main` 槽位 `inject()` 拿到的真 api 来断言契约与首屏渲染。

这个环境则更进一步：连 React 和 DOM 都是真的。

## 用法

```bash
cd test/browser
npm install --no-save react@19 react-dom@19 esbuild   # 一次性
node build.mjs                                        # 打包 site/bundle.js
node server.mjs --reset                               # 起服务（默认 127.0.0.1:8791）
node seed.mjs                                         # 灌一份有代表性的示例数据
```

然后用浏览器打开 <http://127.0.0.1:8791/>，或交给 `ego-browser` 这类工具去点。

`server.mjs` 会：
- 用伪造的 Cordis 上下文调用插件真正的 `apply()`，把 `/ai-workbench/api` 原样挂上；
- 把插件目录下**真实的 `client.js`** 发给浏览器；
- 数据落在 `test/browser/.state/`（`--reset` 清空）。

`site/entry.js` 会捕获 `window.error`、`unhandledrejection` 和 `console.error`，
都塞进 `window.__errors`，所以脚本里可以直接读：

```js
const task = await taskSpace(6);
const page = task.page("p1");
await page.goto("http://127.0.0.1:8791/");
await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 20000 });

// 来回切分页，反复走「跨分页数据错配」这条最容易崩的路径
for (let i = 0; i < 4; i++) {
  await page.click(`loc=css:.aw-tabs button >> nth=${i}`);
  await page.waitForTimeout(800);
  console.log(i, await page.evaluate(() => window.__errors.slice(0, 3)));
}
```

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 真 Host 半体 + 静态站点 + 原样提供 `client.js` |
| `entry.js` | 浏览器侧入口：错误捕获 + 装配 `__ModuleLoader__` + 挂载面板 |
| `build.mjs` | 用 esbuild 把 entry.js 和真 React 打成 `site/bundle.js` |
| `seed.mjs` | 通过真实 API 灌示例数据（含跨日补算、逾期、报表） |
| `site/index.html` | 宿主页面（补齐 `--dsw-alias-*` 主题令牌，让外观接近 DSH） |
