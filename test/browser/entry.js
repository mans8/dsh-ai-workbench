import React from 'react';
import { createRoot } from 'react-dom/client';

const errors = [];
window.__errors = errors;
window.addEventListener('error', (event) => {
  errors.push(`[window.error] ${event.message}\n${event.error && event.error.stack}`);
});
window.addEventListener('unhandledrejection', (event) => {
  errors.push(`[unhandledrejection] ${event.reason}`);
});
const realError = console.error;
console.error = (...args) => {
  errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  realError.apply(console, args);
};

const captured = window.__captured;
if (!captured) {
  document.body.innerHTML = '<pre style="color:red">client.js 没有注册 factory</pre>';
} else {
  const plugin = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`意外的 require: ${name}`);
  });

  let main = null;
  let mainConfig = null;
  let panel = null;
  plugin.apply({
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (config, component) => {
        if (config.name === 'main') { main = component; mainConfig = config; }
        if (config.name === 'sidebar.panellist') panel = component;
        return () => {};
      },
    },
  });

  const { api } = mainConfig.inject();
  window.__api = api;
  window.__panel = panel;

  const root = createRoot(document.getElementById('root'));
  window.__root = root;
  // 每个分页一个可截图 URL：/?tab=hours
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab') || undefined;
  const initialSkin = params.get('skin') || undefined;
  const initialSettings = params.get('settings') === '1';
  window.__renderMain = () => root.render(React.createElement(main, { api, initialTab, initialSkin, initialSettings }));
  window.__renderMain();
  window.__ready = true;
}
