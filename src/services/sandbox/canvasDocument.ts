/**
 * 画布文档构建：把模型生成的 HTML/JS 包装成具备「3D 引擎 import map + KaTeX 数理化 +
 * 错误回传」的 iframe srcdoc。
 *
 * 错误回传：iframe 内 window.onerror / unhandledrejection / console.error 通过
 * postMessage({ source: 'ds-canvas', artifactId, level, message }) 发给父页面，
 * 由 ArtifactCanvas 收集到「控制台」标签，可一键发给 AI 修复。
 */

import { PHYSICS_MACROS } from '../markdown/physicsMacros.js'

const escapeScript = (js: string): string => js.replace(/<\/script>/gi, '<\\/script>')

const errorBridge = (artifactId: string): string => `<script>
(function () {
  var ART = ${JSON.stringify(artifactId)};
  function post(level, message, extra) {
    try {
      parent.postMessage(Object.assign({ source: 'ds-canvas', artifactId: ART, level: level, message: String(message) }, extra || {}), '*');
    } catch (error) {}
  }
  window.addEventListener('error', function (event) {
    post('error', event.message || 'Script error', { line: event.lineno, col: event.colno });
  });
  window.addEventListener('unhandledrejection', function (event) {
    post('error', 'Unhandled rejection: ' + String(event.reason));
  });
  var originalError = console.error;
  console.error = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (typeof value === 'string') { parts.push(value); }
      else { try { parts.push(JSON.stringify(value)); } catch (e) { parts.push(String(value)); } }
    }
    post('console', parts.join(' '));
    originalError.apply(console, arguments);
  };
  window.__dsCanvas = { post: post };
})();
</script>`

const engineHead = (artifactId: string): string => `  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/mhchem.min.js"></script>
  <script>
    window.__DS_KATEX_MACROS = ${JSON.stringify(PHYSICS_MACROS)};
  </script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body, {
      delimiters: [
        {left: '$$', right: '$$', display: true},
        {left: '$', right: '$', display: false},
        {left: '\\\\(', right: '\\\\)', display: false},
        {left: '\\\\[', right: '\\\\]', display: true}
      ],
      macros: window.__DS_KATEX_MACROS || {},
      throwOnError: false
    });"></script>
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
        "chart.js": "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/auto/+esm",
        "matter-js": "https://cdn.jsdelivr.net/npm/matter-js@0.20.0/+esm"
      }
    }
  </script>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; font-family: system-ui, -apple-system, sans-serif; }
    body { overflow: auto; }
  </style>
${errorBridge(artifactId)}`

/** 把生成内容包装成画布文档；完整 HTML 会注入 head，片段则包进 body */
export const buildCanvasSrcDoc = (userCode: string, artifactId: string): string => {
  const code = userCode.trim()
  if (!/<html/i.test(code)) {
    return `<!DOCTYPE html>
<html>
<head>
${engineHead(artifactId)}
</head>
<body>
${code}
</body>
</html>`
  }
  const head = engineHead(artifactId)
  if (/<\/head>/i.test(code)) {
    return code.replace(/<\/head>/i, `${head}\n</head>`)
  }
  if (/<head[^>]*>/i.test(code)) {
    return code.replace(/<head[^>]*>/i, (match) => `${match}\n${head}`)
  }
  return code.replace(/<html[^>]*>/i, (match) => `${match}\n<head>\n${head}\n</head>`)
}

/** JS/TS 产物包装为模块脚本（保留画布底座注入） */
export const buildModuleSrcDoc = (js: string, artifactId: string): string =>
  buildCanvasSrcDoc(
    `<script type="module">${escapeScript(js)}</script>`,
    artifactId
  )
