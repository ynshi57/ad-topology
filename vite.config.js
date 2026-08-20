/**
 * Vite dev server config.
 *
 * Proxies a few express-server endpoints under the same origin as the Vite
 * dev page (5173) so the frontend doesn't need to hardcode a separate
 * ``host:8765`` URL. This is critical when accessing ad-topology through a
 * tunnel (Cursor remote / dev tunnel / SSH forward) where the alternate
 * port may not be exposed at the same hostname.
 *
 * The proxy specifically covers paths used by ``window.open(...)`` /
 * ``<iframe src=...>`` flows where same-origin matters; the rest of the
 * app continues to use absolute ``http://localhost:8765/...`` URLs which
 * also work in the localhost case.
 */
export default {
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        news: 'news.html',
        fault: 'fault-explorer.html',
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Netron model viewer (HTML/JS/CSS/ONNX assets, all under /netron/<model>/...)
      '/netron': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: false,
        ws: false,
      },
      // Backend Server-Sent Events stream for the in-app Debug Log pane.
      // Same-origin so EventSource works without CORS, and so it survives
      // remote tunneling / SSH forwards where port 8765 may not be exposed.
      // ``rewrite`` keeps the upstream path identical; ``selfHandleResponse``
      // is irrelevant here since the proxy passes the bytes through.
      '/server-log': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: false,
        ws: false,
        // Streaming/long-lived: don't buffer.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('accept', 'text/event-stream');
          });
        },
      },
    },
  },
};
