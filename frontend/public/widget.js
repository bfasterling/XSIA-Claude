/*!
 * XSIA Claude — widget de chat para sitios web.
 * <script src="https://TU-DOMINIO/widget.js" data-agent="slug" data-site="clave" data-position="bottom-right"
 *         data-size="md" data-color="#1f6feb" data-icon="chat" data-label="¿Te ayudo?" defer></script>
 */
(function () {
  var s = document.currentScript || document.querySelector('script[data-agent]');
  if (!s || window.__xsiaWidget) return;
  window.__xsiaWidget = true;
  var base = new URL(s.src).origin;
  var d = s.dataset;
  var agent = d.agent;
  if (!agent) return console.warn('[XSIA] data-agent requerido');
  var pos = d.position || 'bottom-right';
  var size = { sm: 48, md: 58, lg: 68 }[d.size || 'md'] || 58;
  var color = d.color || '#1f6feb';
  var label = d.label || '';
  var icons = {
    chat: '<path d="M4 5h16v11H8l-4 4z"/>',
    car: '<path d="M5 16h14v-4l-2-5H7l-2 5zM7 16v2M17 16v2M5 12h14"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01"/>',
    spark: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/>'
  };
  var v = pos.indexOf('top') === 0 ? 'top' : 'bottom';
  var h = pos.indexOf('left') > -1 ? 'left' : 'right';
  var css =
    '.xsia-btn{position:fixed;' + v + ':20px;' + h + ':20px;z-index:2147483000;display:flex;align-items:center;gap:10px;flex-direction:' + (h === 'left' ? 'row' : 'row-reverse') + ';font-family:system-ui,sans-serif}' +
    '.xsia-fab{width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + color + ';border:none;cursor:pointer;display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.22);transition:transform .15s}' +
    '.xsia-fab:hover{transform:scale(1.06)}.xsia-fab svg{width:' + Math.round(size * 0.46) + 'px;height:' + Math.round(size * 0.46) + 'px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.xsia-label{background:#fff;color:#16191f;padding:8px 12px;border-radius:18px;box-shadow:0 4px 14px rgba(0,0,0,.15);font-size:14px;white-space:nowrap}' +
    '.xsia-frame{position:fixed;' + v + ':' + (size + 32) + 'px;' + h + ':20px;width:390px;height:min(640px,calc(100vh - ' + (size + 52) + 'px));border:none;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:2147483001;background:#fff;display:none}' +
    '@media (max-width:520px){.xsia-frame{inset:0;width:100%;height:100%;border-radius:0}}';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var wrap = document.createElement('div');
  wrap.className = 'xsia-btn';
  var btn = document.createElement('button');
  btn.className = 'xsia-fab';
  btn.setAttribute('aria-label', label || 'Abrir chat');
  btn.innerHTML = '<svg viewBox="0 0 24 24">' + (icons[d.icon] || icons.chat) + '</svg>';
  wrap.appendChild(btn);
  if (label) {
    var lb = document.createElement('span');
    lb.className = 'xsia-label';
    lb.textContent = label;
    wrap.appendChild(lb);
  }
  document.body.appendChild(wrap);

  var frame = null;
  function toggle(open) {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.className = 'xsia-frame';
      frame.title = 'Chat';
      frame.allow = 'microphone; autoplay; clipboard-write';
      frame.src = base + '/c/' + encodeURIComponent(agent) + '?embed=1' + (d.site ? '&site=' + encodeURIComponent(d.site) : '');
      document.body.appendChild(frame);
    }
    var show = open !== undefined ? open : frame.style.display !== 'block';
    frame.style.display = show ? 'block' : 'none';
    if (lb) lb.style.display = show ? 'none' : '';
  }
  btn.addEventListener('click', function () { toggle(); });
  window.addEventListener('message', function (e) {
    if (e.origin === base && e.data && e.data.type === 'xsia:close') toggle(false);
  });
  window.XSIA = { open: function () { toggle(true); }, close: function () { toggle(false); } };
})();
