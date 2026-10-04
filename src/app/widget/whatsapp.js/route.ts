import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

/**
 * El script que se instala en cualquier sitio web (ver docs/WIDGET-WHATSAPP.md). Vanilla JS, sin
 * dependencias, con sus propios estilos en línea para no chocar con el CSS del sitio donde se instale.
 * No incluye ningún secreto: el `data-widget-id` es público a propósito (ver la migración 0034).
 */
const SCRIPT = `
(function () {
  var cur = document.currentScript;
  var widgetId = cur && cur.getAttribute('data-widget-id');
  if (!widgetId) return;
  var origin = (function () { try { return new URL(cur.src).origin; } catch (e) { return ''; } })();
  var POS = { 'bottom-right': { right: '20px', left: 'auto' }, 'bottom-left': { left: '20px', right: 'auto' } };
  var SIZE = { small: 48, medium: 56, large: 64 };

  function qs(name) { try { return new URLSearchParams(window.location.search).get(name) || ''; } catch (e) { return ''; } }

  fetch(origin + '/api/widget/' + widgetId + '/config').then(function (r) { return r.json(); }).then(function (cfg) {
    if (!cfg || !cfg.active) return;
    render(cfg);
  }).catch(function () {});

  function render(cfg) {
    var pos = POS[cfg.position] || POS['bottom-right'];
    var dim = SIZE[cfg.size] || SIZE.medium;

    var btn = document.createElement('button');
    btn.setAttribute('aria-label', cfg.buttonText || 'Escríbenos por WhatsApp');
    btn.style.cssText = 'position:fixed;bottom:20px;' + (pos.right !== 'auto' ? 'right:' + pos.right + ';' : 'left:' + pos.left + ';') +
      'z-index:2147483000;display:flex;align-items:center;gap:8px;height:' + dim + 'px;padding:0 ' + (cfg.showText ? '18px' : '0') + ';' +
      'width:' + (cfg.showText ? 'auto' : dim + 'px') + ';border:0;border-radius:999px;background:' + (cfg.color || '#25D366') + ';' +
      'color:#fff;font:600 14px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;cursor:pointer;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.2);justify-content:center;';
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1-.2.2-.7.8-.8 1-.2.2-.3.2-.5.1-.2-.1-1-.4-1.9-1.2-.7-.6-1.2-1.4-1.3-1.6-.1-.2 0-.4.1-.5.1-.1.2-.3.4-.4.1-.1.2-.2.2-.4.1-.1 0-.3 0-.4C10.3 9.7 9.9 8.7 9.7 8.3c-.2-.4-.4-.3-.6-.3h-.5c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 1.9s.8 2.2.9 2.4c.1.2 1.6 2.5 4 3.5.6.2 1 .4 1.3.5.6.2 1.1.2 1.5.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2-.1-.1-.2-.2-.4-.3z"/></svg>' +
      (cfg.showText ? '<span>' + esc(cfg.buttonText || 'Escríbenos') + '</span>' : '');
    document.body.appendChild(btn);

    var panel = buildPanel(cfg, function () { panel.style.display = 'none'; btn.style.display = 'flex'; });
    document.body.appendChild(panel);
    panel.style.display = 'none';

    btn.addEventListener('click', function () { btn.style.display = 'none'; panel.style.display = 'flex'; });
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function buildPanel(cfg, onClose) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483001;width:320px;max-width:calc(100vw - 32px);' +
      'background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.25);font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;flex-direction:column;overflow:hidden;';
    wrap.innerHTML =
      '<div style="background:' + (cfg.color || '#25D366') + ';color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;">' +
      '<strong>' + esc(cfg.buttonText || 'Escríbenos') + '</strong><button type="button" data-x style="background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1;">×</button></div>' +
      '<form data-f style="padding:16px;display:flex;flex-direction:column;gap:10px;">' +
      (cfg.initialMessage ? '<p style="margin:0 0 4px;color:#555;">' + esc(cfg.initialMessage) + '</p>' : '') +
      '<input data-name required placeholder="Tu nombre" style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;" />' +
      '<input data-phone required placeholder="Tu WhatsApp (con indicativo)" style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;" />' +
      '<textarea data-msg rows="3" placeholder="¿En qué te ayudamos?" style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;resize:vertical;"></textarea>' +
      '<p data-err style="color:#c0392b;margin:0;display:none;"></p>' +
      '<button data-submit type="submit" style="padding:10px;border:0;border-radius:8px;background:' + (cfg.color || '#25D366') + ';color:#fff;font:600 14px/1 inherit;cursor:pointer;">Continuar en WhatsApp</button>' +
      '</form>';
    wrap.querySelector('[data-x]').addEventListener('click', onClose);
    wrap.querySelector('[data-f]').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = wrap.querySelector('[data-name]').value;
      var phone = wrap.querySelector('[data-phone]').value;
      var msg = wrap.querySelector('[data-msg]').value;
      var err = wrap.querySelector('[data-err]');
      var submit = wrap.querySelector('[data-submit]');
      err.style.display = 'none';
      submit.disabled = true; submit.textContent = 'Enviando…';
      fetch(origin + '/api/widget/' + widgetId + '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name, phone: phone, message: msg,
          pageUrl: window.location.href, referrer: document.referrer, productUrl: '',
          utmSource: qs('utm_source'), utmMedium: qs('utm_medium'), utmCampaign: qs('utm_campaign'), utmContent: qs('utm_content'),
        }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.ok) { window.location.href = d.redirectUrl; }
        else { err.textContent = d.message || 'Algo salió mal.'; err.style.display = 'block'; submit.disabled = false; submit.textContent = 'Continuar en WhatsApp'; }
      }).catch(function () {
        err.textContent = 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.'; err.style.display = 'block';
        submit.disabled = false; submit.textContent = 'Continuar en WhatsApp';
      });
    });
    return wrap;
  }
})();
`;

export function GET() {
  return new NextResponse(SCRIPT, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
