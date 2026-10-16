// macOS twin of desktop-approve.ps1 (JXA, run by hub.mjs as `osascript -l JavaScript desktop-approve.js <args>`).
// Answers the Claude desktop app's browser approval card for one session at the owner's tap in Telegram: brings the app
// up, switches it to the session by its sidebar entry, reads the site from the card and clicks only when it is the
// expected host, with real mouse clicks (CGEvent; AXPress may be ignored like UI Automation's Invoke on Windows).
// Needs Accessibility for the hub's node. Prints one JSON line: { ok, url, kind, note }.
// usage: desktop-approve.js <title> once|always|deny <expectHost or ''>   |   desktop-approve.js --probe [title]
ObjC.import('CoreGraphics');
function run(argv) {
  const out = o => JSON.stringify(o);
  const se = Application('System Events'), procs = se.processes.whose({ name: 'Claude' });
  if (!procs.length) return out({ ok: false, url: '', kind: '', note: 'no-app' });
  Application('Claude').activate(); delay(0.4);
  const p = procs[0], label = e => { try { return String(e.name() || e.description() || e.value() || ''); } catch { return ''; } };
  const all = w => { try { return w.entireContents(); } catch { return []; } };
  if (argv[0] === '--probe') { // element names that matter, for building / checking the click path
    const rows = [];
    for (const w of p.windows()) {
      if (argv[1]) for (const e of all(w)) if (label(e) === argv[1]) { click(e); delay(1.5); break; }
      for (const e of all(w)) { const n = label(e); let r = ''; try { r = e.role(); } catch {}
        if (/Permission|Allow|Deny|act on|JavaScript/.test(n) || (argv[1] && n === argv[1])) rows.push(`${r} | ${n.slice(0, 120)}`); }
    }
    return rows.join('\n') || 'nothing matched';
  }
  const [title, action, expectHost] = argv;
  for (const w of p.windows()) {
    const item = all(w).find(e => label(e) === title);
    if (!item) continue;
    click(item);
    let card = null;
    for (let i = 0; i < 20 && !card; i++) { delay(0.4); card = all(w).find(e => /^Permission requested: /.test(label(e))); }
    if (!card) return out({ ok: false, url: '', kind: '', note: 'no-card' });
    const text = label(card), kind = /^Permission requested: execute JavaScript/.test(text) ? 'js' : 'site';
    const els = all(w), site = els.map(label).map(s => s.trim()).find(s => /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(s)) || ((text.match(/https?:\/\/[^\s",]+/) || [''])[0].replace(/\.$/, ''));
    const host = /^https?:/.test(site) ? site.replace(/^https?:\/\//, '').split('/')[0] : site.split('/')[0];
    if (expectHost && host !== expectHost) return out({ ok: false, url: site, kind, note: 'host-mismatch' });
    const button = n => all(w).find(e => { try { return e.role() === 'AXButton' && label(e) === n; } catch { return false; } });
    delay(0.4);
    if (action === 'deny' || action === 'always') {
      const b = button(action === 'deny' ? 'Deny' : 'Always allow');
      if (!b) return out({ ok: false, url: site, kind, note: action === 'always' ? 'no-always' : 'no-button' });
      click(b); return out({ ok: true, url: site, kind, note: action });
    }
    let once = button('Allow once');
    if (!once) {
      const more = button('More allow options'); if (!more) return out({ ok: false, url: site, kind, note: 'no-button' });
      click(more);
      for (let i = 0; i < 10 && !once; i++) { delay(0.3); once = all(w).find(e => label(e) === 'Allow once'); }
    }
    if (!once) return out({ ok: false, url: site, kind, note: 'no-allow-once' });
    click(once); return out({ ok: true, url: site, kind, note: 'once' });
  }
  return out({ ok: false, url: '', kind: '', note: 'no-session' });
}
function click(e) { // a real left click at the element's center
  const [x, y] = e.position(), [w, h] = e.size(), pt = $.CGPointMake(x + w / 2, y + h / 2);
  for (const t of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) { $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, t, pt, $.kCGMouseButtonLeft)); delay(0.05); }
}
