import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

/**
 * El script que se instala en cualquier sitio web (ver docs/WIDGET-WHATSAPP.md). Vanilla JS, sin
 * dependencias, con sus propios estilos en línea para no chocar con el CSS del sitio donde se instale.
 * No incluye ningún secreto: el `data-widget-id` es público a propósito (ver la migración 0034).
 *
 * Entrega 2 del refactor (0038): si el widget tiene un menú de intenciones configurado, el panel lo muestra
 * primero y cada intención abre su propio formulario (con sus propios campos y su propio mensaje a
 * WhatsApp). Un widget SIN intenciones configuradas —todos los de antes de esta entrega— se ve y funciona
 * exactamente igual que siempre: el mismo formulario único de nombre/teléfono/mensaje.
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
  function productUrl() {
    try {
      var og = document.querySelector('meta[property="og:url"]'); if (og && og.content) return og.content;
      var canon = document.querySelector('link[rel="canonical"]'); if (canon && canon.href) return canon.href;
    } catch (e) {}
    return '';
  }
  // Misma lógica que src/lib/widget-fields.ts (renderMessageTemplate): sustituye {{variable}}, sin
  // distinguir mayúsculas ni espacios dentro de las llaves, y recorta las líneas que quedan vacías.
  function renderTemplate(tpl, values) {
    var filled = tpl.replace(/\\{\\{\\s*([a-z_]+)\\s*\\}\\}/gi, function (_m, key) {
      var v = values[key.toLowerCase()]; return v == null ? '' : String(v).trim();
    });
    return filled.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  }
  // Mismo formato de siempre cuando no hay una plantilla configurada (ver buildPrefilledMessage en src/lib/widgets.ts).
  function defaultMessage(name, msg) { return 'Hola, soy ' + name.trim() + '. ' + (msg && msg.trim() ? msg.trim() : 'Hola, quiero más información.'); }
  // Entrega 4: el formulario BASE del widget siempre se pregunta; lo propio de la intención elegida se SUMA
  // (si repite una clave del base, la de la intención manda para esa clave). Ver mergeWidgetFields en
  // src/lib/widget-fields.ts — misma lógica, para que las pruebas unitarias cubran el comportamiento real.
  function mergeFields(base, extra) {
    var out = (base || []).slice();
    (extra || []).forEach(function (f) {
      var i = -1;
      for (var j = 0; j < out.length; j++) { if (out[j].key === f.key) { i = j; break; } }
      if (i === -1) out.push(f); else out[i] = f;
    });
    return out;
  }

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

    btn.addEventListener('click', function () { btn.style.display = 'none'; panel.style.display = 'flex'; showHome(panel, cfg); });
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function advisorHtml(cfg) {
    if (!cfg.advisor || !cfg.advisor.name) return '';
    var initial = esc((cfg.advisor.name || '?').trim().charAt(0).toUpperCase());
    var avatar = cfg.advisor.avatarUrl
      ? '<img src="' + esc(cfg.advisor.avatarUrl) + '" alt="" style="width:32px;height:32px;border-radius:999px;object-fit:cover;" />'
      : '<span style="width:32px;height:32px;border-radius:999px;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-weight:700;">' + initial + '</span>';
    return '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;opacity:.95;">' + avatar + '<span>' + esc(cfg.advisor.name) + '</span></div>';
  }

  function buildPanel(cfg, onClose) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483001;width:320px;max-width:calc(100vw - 32px);' +
      'background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.25);font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;flex-direction:column;overflow:hidden;max-height:calc(100vh - 100px);';
    wrap.innerHTML =
      '<div style="background:' + (cfg.color || '#25D366') + ';color:#fff;padding:14px 16px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<strong>' + esc(cfg.buttonText || 'Escríbenos') + '</strong><button type="button" data-x style="background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1;">×</button>' +
      '</div>' + advisorHtml(cfg) + '</div>' +
      '<div data-body style="padding:16px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;"></div>';
    wrap.querySelector('[data-x]').addEventListener('click', onClose);
    return wrap;
  }

  // La «pantalla de inicio» del panel: el menú de intenciones (si hay alguna activa) o, si no, directo al
  // formulario único de siempre — así ningún widget existente cambia de comportamiento.
  function showHome(panel, cfg) {
    var body = panel.querySelector('[data-body]');
    var options = (cfg.options || []).filter(function (o) { return o; });
    if (options.length === 0) { showForm(panel, cfg, null); return; }

    var html = '';
    if (cfg.initialMessage) html += '<p style="margin:0 0 4px;color:#555;">' + esc(cfg.initialMessage) + '</p>';
    if (!cfg.isOpen && cfg.outOfHoursMessage) html += '<p style="margin:0 0 4px;background:#fff7e6;color:#8a6500;padding:8px 10px;border-radius:8px;">' + esc(cfg.outOfHoursMessage) + '</p>';
    html += '<div data-menu style="display:flex;flex-direction:column;gap:8px;"></div>';
    body.innerHTML = html;
    var menu = body.querySelector('[data-menu]');
    options.forEach(function (opt) {
      var item = document.createElement('button');
      item.type = 'button';
      item.style.cssText = 'text-align:left;padding:10px 12px;border:1px solid #e3e3e3;border-radius:10px;background:#fafafa;font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;';
      item.innerHTML = (opt.icon ? '<span>' + esc(opt.icon) + '</span>' : '') + '<span>' + esc(opt.label) + '</span>';
      item.addEventListener('click', function () { showForm(panel, cfg, opt); });
      menu.appendChild(item);
    });
  }

  // El formulario: siempre pregunta el formulario BASE del widget (cfg.fields); si "opt" trae una intención,
  // sus preguntas propias se SUMAN. Sin ningún campo configurado en ninguno de los dos, es el formulario único
  // de siempre (nombre + teléfono + mensaje libre) — así ningún widget existente cambia de comportamiento.
  function showForm(panel, cfg, opt) {
    var body = panel.querySelector('[data-body]');
    var fields = mergeFields(cfg.fields, opt && opt.fields);
    var html = '';
    if (opt) html += '<button type="button" data-back style="align-self:flex-start;background:none;border:0;color:#555;cursor:pointer;padding:0;font:inherit;">← Volver</button>';
    if (!cfg.isOpen && cfg.outOfHoursMessage) html += '<p style="margin:0 0 4px;background:#fff7e6;color:#8a6500;padding:8px 10px;border-radius:8px;">' + esc(cfg.outOfHoursMessage) + '</p>';
    else if (!opt && cfg.initialMessage) html += '<p style="margin:0 0 4px;color:#555;">' + esc(cfg.initialMessage) + '</p>';
    html += '<form data-f style="display:flex;flex-direction:column;gap:10px;">' +
      '<input data-name required placeholder="Tu nombre" style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;" />' +
      '<input data-phone required placeholder="Tu WhatsApp (con indicativo)" style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;" />';
    if (fields.length > 0) {
      fields.forEach(function (f) {
        var ph = esc(f.label || f.key) + (f.required ? ' *' : '');
        var dv = f.defaultValue ? ' value="' + esc(f.defaultValue) + '"' : '';
        if (f.type === 'textarea') {
          html += '<textarea data-field="' + esc(f.key) + '" ' + (f.required ? 'required ' : '') + 'rows="3" placeholder="' + ph + '" style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;resize:vertical;">' + (f.defaultValue ? esc(f.defaultValue) : '') + '</textarea>';
        } else if (f.type === 'select') {
          html += '<select data-field="' + esc(f.key) + '" ' + (f.required ? 'required ' : '') + 'style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;">' +
            '<option value="" disabled selected>' + ph + '</option>' +
            (f.options || []).map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') + '</select>';
        } else {
          var type = f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'phone' ? 'tel' : 'text';
          html += '<input data-field="' + esc(f.key) + '" type="' + type + '" ' + (f.required ? 'required ' : '') + 'placeholder="' + ph + '"' + dv + ' style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;" />';
        }
      });
    } else {
      html += '<textarea data-field="mensaje" rows="3" placeholder="¿En qué te ayudamos?" style="padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit;resize:vertical;"></textarea>';
    }
    html += '<p data-err style="color:#c0392b;margin:0;display:none;"></p>' +
      '<button data-submit type="submit" style="padding:10px;border:0;border-radius:8px;background:' + (cfg.color || '#25D366') + ';color:#fff;font:600 14px/1 inherit;cursor:pointer;">Continuar en WhatsApp</button>' +
      '</form>';
    body.innerHTML = html;

    var backBtn = body.querySelector('[data-back]');
    if (backBtn) backBtn.addEventListener('click', function () { showHome(panel, cfg); });

    body.querySelector('[data-f]').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = body.querySelector('[data-name]').value;
      var phone = body.querySelector('[data-phone]').value;
      var fieldEls = body.querySelectorAll('[data-field]');
      var values = { nombre: name, telefono: phone, origen: qs('utm_source') };
      fieldEls.forEach(function (el) { values[el.getAttribute('data-field')] = el.value; });

      var template = (opt && opt.messageTemplate) || cfg.messageTemplate || null;
      var finalMessage = template ? renderTemplate(template, values) : defaultMessage(name, values.mensaje || '');
      if (!finalMessage) finalMessage = defaultMessage(name, '');

      var err = body.querySelector('[data-err]');
      var submit = body.querySelector('[data-submit]');
      err.style.display = 'none';
      submit.disabled = true; submit.textContent = 'Enviando…';
      var fieldValues = {}; fieldEls.forEach(function (el) { fieldValues[el.getAttribute('data-field')] = el.value; });
      fetch(origin + '/api/widget/' + widgetId + '/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name, phone: phone, message: finalMessage,
          pageUrl: window.location.href, referrer: document.referrer, productUrl: productUrl(),
          utmSource: qs('utm_source'), utmMedium: qs('utm_medium'), utmCampaign: qs('utm_campaign'), utmContent: qs('utm_content'),
          optionId: opt ? opt.id : undefined, fieldValues: fieldValues,
        }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.ok) { window.location.href = d.redirectUrl; }
        else { err.textContent = d.message || 'Algo salió mal.'; err.style.display = 'block'; submit.disabled = false; submit.textContent = 'Continuar en WhatsApp'; }
      }).catch(function () {
        err.textContent = 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.'; err.style.display = 'block';
        submit.disabled = false; submit.textContent = 'Continuar en WhatsApp';
      });
    });
  }
})();
`;

export function GET() {
  return new NextResponse(SCRIPT, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
