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
      noName: '¡Tenemos ganador!',
      calledHistory: 'Cartas cantadas', latest: 'Última', calledTab: 'Cantadas', restTab: 'Faltan',
      ofCalled: function (n) { return 'de ' + n + ' cantadas'; }, spotK: 'El anfitrión abrió esta carta',
      searching: function (q) { return 'Buscando "' + q + '"'; }, notYet: 'Todavía no sale',
      wasNth: function (n) { return 'Sí salió · fue la ' + n + 'ª'; },
      calledNth: function (n, c) { return 'Salió en el lugar ' + n + ' de ' + c; },
      tieTitle: 'Desempate', tieSub: 'Gana la carta más alta', tieEach: 'Cada jugador elige una carta',
      tieAll: '¡Todos eligieron!', tieTop: 'Más alta',
      tieNext: function (n) { return n + ', elige una carta'; },
      tiePicked: function (a, b) { return a + ' de ' + b + ' eligieron'; },
      tieWins: function (n) { return '¡Gana ' + n + '!'; },
      tieWinSub: function (name, num) { return 'Carta más alta: ' + name + ' (#' + num + ')'; },
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
      noName: 'We have a winner!',
      calledHistory: 'Called cards', latest: 'Latest', calledTab: 'Called', restTab: 'Not called yet',
      ofCalled: function (n) { return 'of ' + n + ' called'; }, spotK: 'The host opened this card',
      searching: function (q) { return 'Searching "' + q + '"'; }, notYet: 'Not called yet',
      wasNth: function (n) { return 'Called · it was card ' + n + ' to come out'; },
      calledNth: function (n, c) { return 'Called ' + n + ' of ' + c; },
      tieTitle: 'Tie Breaker', tieSub: 'Highest card wins', tieEach: 'Each player picks a card',
      tieAll: 'Everyone picked!', tieTop: 'Highest',
      tieNext: function (n) { return n + ', pick a card'; },
      tiePicked: function (a, b) { return a + ' of ' + b + ' picked'; },
      tieWins: function (n) { return n + ' wins!'; },
      tieWinSub: function (name, num) { return 'Highest card: ' + name + ' (#' + num + ')'; },
    },
  };

  // ---------------------------------------------------------------- state
  var S = {
    lang: 'es',            // UI language
    names: 'both',         // which card names to show: 'es' | 'en' | 'both'
    layout: 'history',     // 'history' (default) | 'card' (card only)
    look: null,            // what the host is looking at in History: { kind: 'search'|'card', id, order, q }
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
    tie: null,             // Tie Breaker round: { phase, picks: [{ id, who, top }], winner, next }
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
    if (S.status === 'tie' && S.tie && S.deck) return 'tie';
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
      (screen === 'tie' && S.tie.phase === 'done' ? ' tie-done' : '') +
      (!S.connected && S.status !== 'idle' ? ' offline' : '');

    if (screen === 'ready') {
      $('readyDeck').textContent = S.deck ? S.deck.name : '';
      $('readyCaller').textContent = S.caller && S.caller.name ? t().caller(S.caller.name) : '';
    }
    if (screen === 'ended') {
      $('endedText').textContent = t().endedText(S.called.length);
    }
    if (screen === 'winner') {
      // "Winner"/"Ganador" means nobody was named: celebrate without a name.
      var named = (S.winners || []).filter(function (n) { return n && !/^(winner|ganador|manual winner)$/i.test(String(n).trim()); });
      $('winnerNames').textContent = named.length ? named.join(' · ') : t().noName;
      startConfetti('confetti');
    } else {
      stopConfetti('confetti');
    }
    if (screen === 'game') renderGame();
    if (screen === 'tie') renderTie(); else stopConfetti('tieConfetti');
  }

  /** Older apps send 'card-board' or 'board': both are now the History view. */
  function layoutOf(l) { return l === 'card' ? 'card' : 'history'; }

  function renderGame() {
    if (S.layout === 'history') renderHist(); else renderCardOnly();
    renderLook();
  }

  function renderCardOnly() {
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

  }

  /** Card number as printed: official decks use the card's number, custom decks their deck order. */
  function numFor(card) {
    if (!card) return '';
    return String(S.deck && S.deck.type === 'custom' ? indexOfCard(card.id) + 1 : card.id);
  }

  /** px per "u" (1% of the 16:9 frame width), the unit the stylesheet uses. */
  function unit() {
    // Same as --u in styles.css: 1% of the widest 16:9 box inside the safe edges.
    var W = app.clientWidth, H = app.clientHeight;
    return Math.min((W - 2 * W * 0.035) / 100, (H - 2 * H * 0.04) * 0.017778) || 10;
  }

  /**
   * Picks the column count that makes n tiles as big as possible inside the grid's box
   * (its .fit-area parent), so every tile is always on screen. ratio = picture height / width;
   * extra = px under each picture (a name line); cap = largest tile width in px.
   * Returns the tile width in px.
   */
  function fitGrid(grid, n, ratio, extra, gap, cap) {
    var box = grid.parentNode;
    var W = box.clientWidth, H = box.clientHeight;
    if (!n || !W || !H) return 0;
    var best = 0, bestCols = 1;
    for (var cols = 1; cols <= n; cols++) {
      var rows = Math.ceil(n / cols);
      var byW = (W - gap * (cols - 1)) / cols;
      var byH = ((H - gap * (rows - 1)) / rows - extra) / ratio;
      var w = Math.min(byW, byH, cap);
      if (w > best + 0.5) { best = w; bestCols = cols; }
    }
    best = Math.max(0, Math.floor(best));
    grid.style.gridTemplateColumns = 'repeat(' + bestCols + ', ' + best + 'px)';
    grid.style.gap = gap + 'px';
    return best;
  }

  // ---------------------------------------------------------------- History view
  var tiles = {};    // card id -> tile element (moved between the two grids, so pictures never reload)
  var histFlip = null;

  function tileFor(card) {
    var el = tiles[card.id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.innerHTML = '<div class="f"><img alt=""><span class="ph"></span></div><span class="o"></span><span class="tag"></span>';
      el.querySelector('.ph').textContent = numFor(card);
      tiles[card.id] = el;
    }
    var img = el.querySelector('img'), src = imgFor(card, true);
    if (src && img.getAttribute('src') !== src) { img.setAttribute('src', src); el.classList.add('has-img'); }
    return el;
  }

  /**
   * Largest tile size so both grids (called on top, not called below; each wraps on its own)
   * fit the right column. Returns { w, cols } in px.
   */
  function fitTwo(nA, nB, W, H, gap, head, between) {
    var best = { w: 0, cols: 1 };
    for (var cols = 3; cols <= 24; cols++) {
      var w = (W - gap * (cols - 1)) / cols, h = w / 0.7;
      var rA = Math.max(1, Math.ceil(nA / cols)), rB = nB ? Math.ceil(nB / cols) : 0;
      var total = head + rA * h + (rA - 1) * gap + (nB ? between + head + rB * h + (rB - 1) * gap : 0);
      if (total <= H && w > best.w) best = { w: Math.floor(w), cols: cols };
    }
    return best;
  }

  function renderHist() {
    var card = cardById(S.current);
    var total = S.total || (S.deck ? S.deck.cards.length : 0);
    var n = S.called.length;
    $('hDeck').textContent = S.deck ? S.deck.name : '';
    $('hCaller').textContent = S.caller && S.caller.name ? S.caller.name : '';
    var nm = namesFor(card);
    $('hName').textContent = nm.main;
    $('hName').className = 'h-name' + (nm.main.length > 14 ? ' long' : '');
    $('hSub').textContent = nm.sub;
    $('hNum').textContent = card ? '#' + numFor(card) : '';
    $('hCardNum').textContent = card ? numFor(card) : '';
    $('hCount').textContent = String(n);
    $('hOf').textContent = t().ofCalled(total);
    $('hAuto').textContent = S.auto && S.auto.on && S.status === 'playing' ? t().auto(S.auto.secs) : '';
    $('hFill').style.width = (total ? Math.min(100, (n / total) * 100) : 0) + '%';
    var img = $('hImg'), src = imgFor(card, false);
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    if (histFlip !== S.current) {
      var el = $('hCard');
      el.classList.remove('flip'); void el.offsetWidth; el.classList.add('flip');
      histFlip = S.current;
    }

    // Called (newest first) and not called yet (deck order). Together they are the whole deck,
    // so the tiles keep the same size all game; a card just moves up when it's called.
    var calledSet = {}, newest = S.called.slice().reverse(), rest = [];
    for (var i = 0; i < S.called.length; i++) calledSet[S.called[i]] = true;
    S.deck.cards.forEach(function (c) { if (!calledSet[c.id]) rest.push(c); });
    $('hCalledN').textContent = String(newest.length);
    $('hRestN').textContent = String(rest.length);
    $('hRestSec').style.display = rest.length ? '' : 'none';

    var u = unit(), right = $('hRight');
    var head = $('hCalledLabel').offsetHeight + u * 0.7;
    var f = fitTwo(Math.max(1, newest.length), rest.length, right.clientWidth, right.clientHeight, u * 0.62, head, u * 1.25);
    var cols = 'repeat(' + f.cols + ', ' + f.w + 'px)';
    [$('hCalled'), $('hRest')].forEach(function (g) { g.style.gridTemplateColumns = cols; g.style.gap = (u * 0.62) + 'px'; g.style.setProperty('--tile', f.w + 'px'); });

    var hit = S.look && S.look.kind === 'search' ? S.look.id : null;
    var gC = $('hCalled'), gR = $('hRest');
    newest.forEach(function (id, k) {
      var c = cardById(id); if (!c) return;
      var el = tileFor(c);
      el.classList.add('on');
      el.classList.toggle('latest', k === 0);
      el.classList.toggle('ring', hit === id);
      el.querySelector('.o').textContent = String(newest.length - k);
      el.querySelector('.tag').textContent = k === 0 ? t().latest : '';
      if (gC.children[k] !== el) gC.insertBefore(el, gC.children[k] || null);
    });
    while (gC.children.length > newest.length) gR.appendChild(gC.lastChild);
    rest.forEach(function (c, k) {
      var el = tileFor(c);
      el.classList.remove('on', 'latest');
      el.classList.toggle('ring', hit === c.id);
      el.querySelector('.o').textContent = '';
      el.querySelector('.tag').textContent = '';
      if (gR.children[k] !== el) gR.insertBefore(el, gR.children[k] || null);
    });
    while (gR.children.length > rest.length) gR.removeChild(gR.lastChild);
  }

  /** What the host is looking at in History on the phone: a search answer or one card, big. */
  function renderLook() {
    var look = S.look, c = look && look.id != null ? cardById(look.id) : null;
    var showAns = !!(look && look.kind === 'search' && c);
    var showSpot = !!(look && look.kind === 'card' && c);
    app.classList.toggle('look-ans', showAns);
    app.classList.toggle('look-spot', showSpot);
    if (!c) return;
    var order = S.called.indexOf(c.id) + 1, nm = namesFor(c);
    if (showAns) {
      $('ansImg').setAttribute('src', imgFor(c, true));
      $('ansQ').textContent = t().searching(look.q || '');
      $('ansName').textContent = nm.main;
      $('ansNum').textContent = '#' + numFor(c);
      $('ansR').textContent = order ? t().wasNth(order) : t().notYet;
      $('answer').classList.toggle('no', !order);
      $('ansDot').innerHTML = order ? ICON_CHECK : ICON_X;
    }
    if (showSpot) {
      var src = imgFor(c, false);
      if ($('spotImg').getAttribute('src') !== src) $('spotImg').setAttribute('src', src);
      $('spotName').textContent = nm.main;
      $('spotSub').textContent = (nm.sub ? nm.sub + ' · ' : '') + '#' + numFor(c);
      $('spotR').innerHTML = (order ? ICON_CHECK_TEAL : ICON_X_CORAL) + '<span></span>';
      $('spotR').lastChild.textContent = order ? t().calledNth(order, S.called.length) : t().notYet;
      $('spot').classList.toggle('no', !order);
    }
  }
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="#062B2B" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_CHECK_TEAL = ICON_CHECK.replace('#062B2B', '#14B8B8');
  var ICON_X_CORAL = ICON_X.replace('#fff', '#F2685C');

  /** Tie Breaker: face-down cards, each player's flip, the highest card, then the winner. */
  function renderTie() {
    var tie = S.tie, picks = tie.picks || [];
    var up = picks.filter(function (p) { return p.id != null; }).length;
    var status = '';
    if (tie.phase === 'pick') status = (tie.next ? t().tieNext(tie.next) : t().tieEach) + (up ? '  ·  ' + t().tiePicked(up, picks.length) : '');
    else status = t().tieAll;
    $('tieStatus').textContent = status;

    var grid = $('tieGrid');
    var u = unit();
    var key = [S.deck.id, S.lang, grid.parentNode.clientWidth, grid.parentNode.clientHeight, JSON.stringify(picks),
      picks.map(function (p) { return p.id != null ? imgFor(cardById(p.id), true) : ''; }).join('|')].join(';');
    if (key === tieKey) { renderTieWin(tie); return; }
    tieKey = key;
    var w = fitGrid(grid, picks.length, 1.43, u * 3, u * 1.4, u * 17);
    grid.style.setProperty('--tile', w + 'px');
    var html = '';
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i], c = p.id != null ? cardById(p.id) : null;
      // Only a card that just flipped plays the flip animation.
      var fresh = c && !tieSeen[i + ':' + p.id];
      if (c) tieSeen[i + ':' + p.id] = true;
      html += '<div class="ttile' + (c ? ' up' : '') + (fresh ? ' fresh' : '') + (p.top ? ' top' : '') + '">' +
        '<div class="frame">' + (c ? '<img src="' + escapeAttr(imgFor(c, true)) + '" alt="">' : '<div class="back"><img src="img/brand/rooster.png" alt=""></div>') + '</div>' +
        (p.top ? '<span class="tag">' + escapeAttr(t().tieTop) + '</span>' : '') +
        (c ? '<span class="order">#' + escapeAttr(numFor(c)) + '</span>' : '') +
        '<div class="tname">' + escapeAttr(p.who || '') + '</div></div>';
    }
    grid.innerHTML = html;
    renderTieWin(tie);
  }

  var tieKey = '';
  var tieSeen = {};
  function renderTieWin(tie) {
    var top = null;
    (tie.picks || []).forEach(function (p) { if (p.top && p.id != null) top = { pick: p, card: cardById(p.id) }; });
    if (tie.phase === 'done' && top && top.card) {
      var src = imgFor(top.card, false);
      if ($('tieWinImg').getAttribute('src') !== src) $('tieWinImg').setAttribute('src', src);
      $('tieWinTitle').textContent = top.pick.who ? t().tieWins(tie.winner || top.pick.who) : t().noName;
      $('tieWinSub').textContent = t().tieWinSub(namesFor(top.card).main, numFor(top.card));
      startConfetti('tieConfetti');
    } else {
      stopConfetti('tieConfetti');
    }
  }

  function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // Confetti for the winner screen
  var confettiOn = {};
  function startConfetti(id) {
    if (confettiOn[id]) return;
    confettiOn[id] = true;
    var box = $(id), colors = ['#FEB500', '#14B8B8', '#EB4C1B', '#8B5CF6', '#F9EFE7', '#2E9E6B'], html = '';
    for (var i = 0; i < 70; i++) {
      html += '<i style="left:' + (Math.random() * 100) + '%;background:' + colors[i % colors.length] +
        ';animation-duration:' + (3 + Math.random() * 3) + 's;animation-delay:' + (-Math.random() * 5) + 's"></i>';
    }
    box.innerHTML = html;
  }
  function stopConfetti(id) { if (confettiOn[id]) { $(id).innerHTML = ''; confettiOn[id] = false; } }

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
    if (m.layout) S.layout = layoutOf(m.layout);
    if (m.caller) S.caller = m.caller;
    if (m.deck) {
      var changed = !S.deck || S.deck.id !== m.deck.id;
      S.deck = m.deck;
      if (changed) { images = {}; parts = {}; asked = {}; tiles = {}; $('hCalled').innerHTML = ''; $('hRest').innerHTML = ''; }
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
    if ('look' in m) S.look = m.look || null;
    if ('tie' in m) {
      S.tie = m.tie || null;
      // New round (nothing flipped yet) or Tie Breaker closed: forget which cards already flipped.
      if (!S.tie || !(S.tie.picks || []).some(function (p) { return p.id != null; })) tieSeen = {};
    }
    if (m.layout) S.layout = layoutOf(m.layout);
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
    if (S.tie && S.tie.picks) S.tie.picks.forEach(function (p) { if (p.id != null) wanted.unshift(p.id); });
    if (S.look && S.look.id != null) wanted.unshift(S.look.id);
    // The History view shows every card, so the rest of the deck comes after the called ones.
    if (S.layout === 'history') S.deck.cards.forEach(function (c) { wanted.push(c.id); });
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
  if (params.has('test') || params.has('demo')) window.ldReceiver = { handle: handle, state: S, fit: fit, onSend: function (fn) { send = fn; } };

  // ---------------------------------------------------------------- AirPlay (iPhone second screen)
  // The app shows this page full-screen on the AirPlay TV and calls window.ldReceiver.handle(msg);
  // replies go back through the "ld" WebKit message handler. Same protocol as Chromecast.
  var airplay = params.has('airplay') && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ld;
  if (airplay) {
    send = function (obj) { try { window.webkit.messageHandlers.ld.postMessage(obj); } catch (e) {} };
    window.ldReceiver = { handle: handle, state: S, fit: fit };
    // Newer apps pass the TV's exact size (points); older ones don't, and the viewport is used.
    if (window.__ldSize) fit(window.__ldSize.w, window.__ldSize.h);
    send({ type: 'loaded', protocol: PROTOCOL, w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio });
  }

  /** Lays the page out for an exact screen size (px) and stops the web view from zooming it. */
  function fit(w, h) {
    w = Math.round(Number(w)); h = Math.round(Number(h));
    if (!(w > 0 && h > 0)) return;
    var meta = document.querySelector('meta[name=viewport]');
    if (meta) meta.setAttribute('content', 'width=' + w + ', height=' + h + ', initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no');
    var root = document.documentElement.style;
    root.setProperty('--W', w + 'px');
    root.setProperty('--H', h + 'px');
    render();
  }

  function startDemo(p) {
    var lang = p.get('lang') === 'en' ? 'en' : 'es';
    fetch('demo-classic.json').then(function (r) { return r.json(); }).then(function (cards) {
      var deck = { id: 'classic', name: 'Lotería Clásica', type: 'official', cards: cards.map(function (c) { return { id: c.id, es: c.es, en: c.en, img: 'classic' }; }) };
      handle({ type: 'hello', lang: lang, names: p.get('names') || 'both', layout: p.get('layout') || 'history', deck: deck, caller: { name: 'Abuela Rosa' } });
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
        // demo.look('search' | 'card' | null, cardId, query)
        look: function (kind, id, q) {
          handle({ type: 'state', sid: 'demo', seq: seq++, status: status, look: kind ? { kind: kind, id: id, q: q || '' } : null });
        },
        called: function () { return called.slice(); },
        // demo.tie('pick' | 'reveal' | 'done' | null, players = 4)
        tie: function (phase, n) {
          if (!phase) { handle({ type: 'state', sid: 'demo', seq: seq++, status: status, tie: null }); return; }
          n = n || 4;
          var who = ['María', 'Tío Beto', 'Abuela', 'Carlos', 'Lupe', 'Juan', 'Sofi', 'Pepe'];
          var ids = order.slice(20, 20 + n), up = phase === 'pick' ? 2 : n, best = -1;
          for (var i = 0; i < up; i++) if (best < 0 || ids[i] > ids[best]) best = i;
          var picks = ids.map(function (id, i) { return { id: i < up ? id : null, who: i < up ? (who[i] || 'Jugador ' + (i + 1)) : '', top: i === best }; });
          handle({ type: 'state', sid: 'demo', seq: seq++, status: 'tie', tie: { phase: phase, picks: picks, winner: phase === 'done' ? picks[best].who : '', next: phase === 'pick' ? (who[up] || '') : '' } });
        },
      };
    });
  }

  window.addEventListener('resize', function () { render(); });
  render();
})();
