/*
 * Lotería Duo — Google Cast Custom Web Receiver.
 *
 * The phone runs the game; this page only shows it. The phone sends JSON messages on the
 * namespace below (see README.md for the full protocol):
 *   hello  — deck, caller, language, layout (sent on every connect / resume)
 *   state  — current card, called cards, status (sent on every change)
 *   image  — chunks of a custom-deck picture the TV can't download itself
 * The TV answers with `ready` and `need` (pictures it is missing).
 *
 * Open with ?demo in a normal browser to preview without a Chromecast.
 */
(function () {
  'use strict';

  var NS = 'urn:x-cast:com.loteriaduo.game';
  var PROTOCOL = 1;

  var T = {
    es: {
      idleHint: 'Abre Lotería Duo en tu teléfono y toca el ícono de transmitir.',
      idleHint2: 'Open Lotería Duo on your phone and tap the Cast icon.',
      ready: '¡Listos para jugar!', waitingFirst: 'Esperando la primera carta…',
      recent: 'Últimas cartas', called: 'Cartas que ya salieron', paused: 'En pausa',
      ended: 'Juego terminado', reconnecting: 'Reconectando con el teléfono…',
      cardOf: function (a, b) { return 'Carta ' + a + ' de ' + b; },
      endedText: function (n) { return n === 1 ? 'Salió 1 carta.' : 'Salieron ' + n + ' cartas.'; },
      auto: function (s) { return 'Automático · ' + s + ' s'; },
      caller: function (n) { return 'Canta: ' + n; },
    },
    en: {
      idleHint: 'Open Lotería Duo on your phone and tap the Cast icon.',
      idleHint2: 'Abre Lotería Duo en tu teléfono y toca el ícono de transmitir.',
      ready: 'Ready to play!', waitingFirst: 'Waiting for the first card…',
      recent: 'Recent cards', called: 'Cards called', paused: 'Paused',
      ended: 'Game over', reconnecting: 'Reconnecting to the phone…',
      cardOf: function (a, b) { return 'Card ' + a + ' of ' + b; },
      endedText: function (n) { return n === 1 ? '1 card was called.' : n + ' cards were called.'; },
      auto: function (s) { return 'Auto · ' + s + 's'; },
      caller: function (n) { return 'Caller: ' + n; },
    },
  };

  // ---------------------------------------------------------------- state
  var S = {
    lang: 'es',            // UI language
    names: 'both',         // which card names to show: 'es' | 'en' | 'both'
    layout: 'card-board',  // 'card-board' | 'card' | 'board'
    deck: null,            // { id, name, type, cards: [{ id, es, en, img }] }
    caller: null,          // { name }
    status: 'idle',        // 'idle' | 'ready' | 'playing' | 'paused' | 'ended' | 'winner'
    sid: null,             // game session id (resets sequence numbers)
    seq: -1,
    current: null,         // card id
    called: [],            // card ids in order
    total: 0,
    auto: null,            // { on, secs }
    winners: [],
    connected: false,
  };
  var images = {};   // card id -> image URL (blob: or https:)
  var parts = {};    // card id -> { got, parts, chunks[] }
  var lastShown = null;

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');

  function t() { return T[S.lang] || T.es; }

  function cardById(id) {
    if (!S.deck) return null;
    for (var i = 0; i < S.deck.cards.length; i++) if (S.deck.cards[i].id === id) return S.deck.cards[i];
    return null;
  }
  function indexOfCard(id) {
    if (!S.deck) return -1;
    for (var i = 0; i < S.deck.cards.length; i++) if (S.deck.cards[i].id === id) return i;
    return -1;
  }

  /** Where to load a card's picture from: bundled Classic art, a cloud URL, or a picture the phone sent. */
  function imgFor(card, thumb) {
    if (!card) return 'img/brand/rooster.png';
    if (card.img === 'classic') return 'img/classic/' + (thumb ? 'thumb' : 'full') + '/' + card.id + '.jpg';
    if (card.img) return card.img;
    return images[card.id] || '';
  }

  function namesFor(card) {
    if (!card) return { main: '', sub: '' };
    var es = card.es || card.en || '', en = card.en || card.es || '';
    if (S.names === 'en') return { main: en, sub: '' };
    if (S.names === 'es') return { main: es, sub: '' };
    // both: the app's language first
    var first = S.lang === 'en' ? en : es, second = S.lang === 'en' ? es : en;
    return { main: first, sub: second !== first ? second : '' };
  }

  // ---------------------------------------------------------------- render
  function applyStrings() {
    var nodes = document.querySelectorAll('[data-t]');
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-t');
      if (typeof t()[k] === 'string') nodes[i].textContent = t()[k];
    }
    document.documentElement.lang = S.lang;
  }

  function screenFor() {
    if (!S.connected && S.status === 'idle') return 'idle';
    if (S.status === 'winner') return 'winner';
    if (S.status === 'ended') return 'ended';
    if (S.status === 'idle' || (S.status === 'ready' && S.current == null) || !S.deck) return S.deck ? 'ready' : 'idle';
    return 'game';
  }

  function render() {
    applyStrings();
    var screen = screenFor();
    app.className = 'screen-' + screen + ' layout-' + S.layout + ' deck-' + (S.deck && S.deck.type === 'custom' ? 'custom' : 'official') +
      (S.status === 'paused' ? ' paused' : '') +
      (!S.connected && S.status !== 'idle' ? ' offline' : '');

    if (screen === 'ready') {
      $('readyDeck').textContent = S.deck ? S.deck.name : '';
      $('readyCaller').textContent = S.caller && S.caller.name ? t().caller(S.caller.name) : '';
    }
    if (screen === 'ended') {
      $('endedText').textContent = t().endedText(S.called.length);
    }
    if (screen === 'winner') {
      $('winnerNames').textContent = (S.winners || []).join(' · ');
      startConfetti();
    } else {
      stopConfetti();
    }
    if (screen === 'game') renderGame();
  }

  function renderGame() {
    var card = cardById(S.current);
    var total = S.total || (S.deck ? S.deck.cards.length : 0);
    var n = S.called.length;

    $('deckName').textContent = S.deck ? S.deck.name : '';
    $('callerName').textContent = S.caller && S.caller.name ? S.caller.name : '';
    var nm = namesFor(card);
    $('nameMain').textContent = nm.main;
    $('nameMain').className = 'name-main' + (nm.main.length > 18 ? ' long' : '');
    $('nameSub').textContent = nm.sub;
    // Official decks use the traditional card number; custom decks number cards in deck order.
    $('cardNum').textContent = card ? String(S.deck.type === 'custom' ? indexOfCard(card.id) + 1 : card.id) : '';
    $('cardNum').style.display = card ? '' : 'none';
    $('nameNum').textContent = card ? '#' + $('cardNum').textContent : '';
    $('progressText').textContent = t().cardOf(Math.max(n, card ? 1 : 0), total);
    $('autoText').textContent = S.auto && S.auto.on && S.status === 'playing' ? t().auto(S.auto.secs) : '';
    $('progressFill').style.width = (total ? Math.min(100, (n / total) * 100) : 0) + '%';

    // Big card (flip only when the card changes)
    var img = $('cardImg');
    var src = imgFor(card, false);
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    if (lastShown !== S.current) {
      var el = $('card');
      el.classList.remove('flip');
      void el.offsetWidth; // restart the animation
      el.classList.add('flip');
      lastShown = S.current;
    }

    // Recent cards (newest first, current excluded)
    var recent = $('recent');
    var prev = S.called.slice(0, -1).slice(-6).reverse();
    var html = '';
    for (var i = 0; i < prev.length; i++) {
      html += '<div class="mini"><img src="' + escapeAttr(imgFor(cardById(prev[i]), true)) + '" alt=""></div>';
    }
    recent.innerHTML = html;

    renderBoard();
  }

  var boardKey = '';
  function renderBoard() {
    var board = $('board');
    if (!S.deck) return;
    var cards = S.deck.cards;
    var key = S.deck.id + ':' + cards.length + ':' + S.layout;
    if (key !== boardKey) {
      // Pick columns so the board fits: 14 for a full deck, fewer for small decks.
      var count = cards.length;
      var cols = S.layout === 'board' ? Math.min(12, Math.max(4, Math.ceil(Math.sqrt(count * 1.6)))) : Math.min(14, Math.max(4, Math.ceil(count / 4)));
      board.style.setProperty('--cols', cols);
      var html = '';
      for (var i = 0; i < count; i++) {
        html += '<div class="cell" data-id="' + cards[i].id + '"><img alt=""><span class="n">' + (i + 1) + '</span></div>';
      }
      board.innerHTML = html;
      boardKey = key;
    }
    var calledSet = {};
    for (var j = 0; j < S.called.length; j++) calledSet[S.called[j]] = true;
    var cells = board.children;
    for (var k = 0; k < cells.length; k++) {
      var id = Number(cells[k].getAttribute('data-id'));
      var on = !!calledSet[id];
      cells[k].classList.toggle('on', on);
      cells[k].classList.toggle('now', id === S.current);
      var im = cells[k].firstChild;
      var want = on ? imgFor(cardById(id), true) : '';
      if (want && im.getAttribute('src') !== want) im.setAttribute('src', want);
    }
  }

  function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // Confetti for the winner screen
  var confettiOn = false;
  function startConfetti() {
    if (confettiOn) return;
    confettiOn = true;
    var box = $('confetti'), colors = ['#FEB500', '#14B8B8', '#EB4C1B', '#8B5CF6', '#F9EFE7', '#2E9E6B'], html = '';
    for (var i = 0; i < 70; i++) {
      html += '<i style="left:' + (Math.random() * 100) + '%;background:' + colors[i % colors.length] +
        ';animation-duration:' + (3 + Math.random() * 3) + 's;animation-delay:' + (-Math.random() * 5) + 's"></i>';
    }
    box.innerHTML = html;
  }
  function stopConfetti() { if (confettiOn) { $('confetti').innerHTML = ''; confettiOn = false; } }

  // ---------------------------------------------------------------- messages
  var send = function () {};

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello': onHello(msg); break;
      case 'state': onState(msg); break;
      case 'image': onImage(msg); break;
      case 'ping': S.connected = true; break;
    }
  }

  function onHello(m) {
    S.connected = true;
    if (m.lang) S.lang = m.lang === 'en' ? 'en' : 'es';
    if (m.names) S.names = m.names;
    if (m.layout) S.layout = m.layout;
    if (m.caller) S.caller = m.caller;
    if (m.deck) {
      var changed = !S.deck || S.deck.id !== m.deck.id;
      S.deck = m.deck;
      if (changed) { images = {}; parts = {}; boardKey = ''; }
    }
    render();
    send({ type: 'ready', protocol: PROTOCOL, have: Object.keys(images).map(Number) });
    requestMissing();
  }

  function onState(m) {
    if (m.sid !== S.sid) { S.sid = m.sid; S.seq = -1; }
    if (typeof m.seq === 'number' && m.seq <= S.seq) return; // old or duplicate
    if (typeof m.seq === 'number') S.seq = m.seq;
    S.connected = true;
    if (m.status) S.status = m.status;
    if ('current' in m) S.current = m.current;
    if (m.called) S.called = m.called;
    if (m.total) S.total = m.total;
    if (m.auto) S.auto = m.auto;
    if (m.winners) S.winners = m.winners;
    if (m.layout) S.layout = m.layout;
    if (m.names) S.names = m.names;
    if (m.lang) S.lang = m.lang === 'en' ? 'en' : 'es';
    render();
    requestMissing();
  }

  /** Custom-deck pictures arrive in base64 chunks (Cast messages are limited to 64 KB). */
  function onImage(m) {
    if (!S.deck || m.deckId !== S.deck.id) return;
    var p = parts[m.id] || (parts[m.id] = { got: 0, parts: m.parts, chunks: [] });
    if (p.chunks[m.part] == null) { p.chunks[m.part] = m.data; p.got++; }
    if (p.got === p.parts) {
      var bin = atob(p.chunks.join(''));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      images[m.id] = URL.createObjectURL(new Blob([bytes], { type: m.mime || 'image/jpeg' }));
      delete parts[m.id];
      render();
    }
  }

  /** Ask the phone for pictures we can't load ourselves: current card first, then upcoming/called ones. */
  var asked = {};
  function requestMissing() {
    if (!S.deck) return;
    var need = [];
    var wanted = [S.current].concat(S.called.slice().reverse());
    for (var i = 0; i < wanted.length; i++) {
      var c = cardById(wanted[i]);
      if (c && !c.img && !images[c.id] && !asked[c.id]) { need.push(c.id); asked[c.id] = true; }
    }
    if (need.length) send({ type: 'need', deckId: S.deck.id, ids: need.slice(0, 12) });
  }

  // ---------------------------------------------------------------- Cast
  var onCast = /CrKey|Android TV|GoogleTV|Fuchsia/i.test(navigator.userAgent) && window.cast && cast.framework;
  if (onCast) {
    var ctx = cast.framework.CastReceiverContext.getInstance();
    var lastSender = null;
    ctx.addCustomMessageListener(NS, function (e) {
      lastSender = e.senderId;
      var data = e.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch (err) { return; } }
      handle(data);
    });
    ctx.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function () { S.connected = true; render(); });
    ctx.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function () {
      // Keep showing the last card; the phone resumes the session and resends everything.
      if (ctx.getSenders().length === 0) { S.connected = false; render(); }
    });
    send = function (obj) {
      try {
        if (lastSender) ctx.sendCustomMessage(NS, lastSender, obj);
        else ctx.sendCustomMessage(NS, undefined, obj); // broadcast
      } catch (err) { /* sender may be gone */ }
    };
    var options = new cast.framework.CastReceiverOptions();
    options.disableIdleTimeout = true; // a game can sit paused for a long time
    options.customNamespaces = {};
    options.customNamespaces[NS] = cast.framework.system.MessageType.JSON;
    options.statusText = 'Lotería Duo';
    ctx.start(options);
  }

  // ---------------------------------------------------------------- demo (browser preview)
  var params = new URLSearchParams(location.search);
  if (params.has('demo')) startDemo(params);
  // Test hook for feeding messages from the browser console (never active on a TV).
  if (params.has('test') || params.has('demo')) window.ldReceiver = { handle: handle, state: S, onSend: function (fn) { send = fn; } };

  // ---------------------------------------------------------------- AirPlay (iPhone second screen)
  // The app shows this page full-screen on the AirPlay TV and calls window.ldReceiver.handle(msg);
  // replies go back through the "ld" WebKit message handler. Same protocol as Chromecast.
  var airplay = params.has('airplay') && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ld;
  if (airplay) {
    send = function (obj) { try { window.webkit.messageHandlers.ld.postMessage(obj); } catch (e) {} };
    window.ldReceiver = { handle: handle, state: S };
    send({ type: 'loaded', protocol: PROTOCOL });
  }

  function startDemo(p) {
    var lang = p.get('lang') === 'en' ? 'en' : 'es';
    fetch('demo-classic.json').then(function (r) { return r.json(); }).then(function (cards) {
      var deck = { id: 'classic', name: 'Lotería Clásica', type: 'official', cards: cards.map(function (c) { return { id: c.id, es: c.es, en: c.en, img: 'classic' }; }) };
      handle({ type: 'hello', lang: lang, names: p.get('names') || 'both', layout: p.get('layout') || 'card-board', deck: deck, caller: { name: 'Abuela Rosa' } });
      var order = deck.cards.map(function (c) { return c.id; }).sort(function () { return Math.random() - 0.5; });
      var called = order.slice(0, Number(p.get('n') || 8));
      var seq = 0;
      var status = p.get('status') || 'playing';
      function push() {
        handle({ type: 'state', sid: 'demo', seq: seq++, status: status, current: called[called.length - 1], called: called.slice(), total: 54, auto: { on: true, secs: 5 }, winners: ['María', 'Tío Beto'] });
      }
      push();
      if (p.has('auto')) setInterval(function () {
        if (called.length < order.length) { called.push(order[called.length]); push(); }
      }, 4000);
      window.demo = {
        next: function () { if (called.length < order.length) { called.push(order[called.length]); push(); } },
        status: function (s) { status = s; push(); },
        layout: function (l) { handle({ type: 'state', sid: 'demo', seq: seq++, layout: l }); },
        offline: function () { S.connected = false; render(); },
      };
    });
  }

  render();
})();
