// ==UserScript==
// @name         hh.ru — автоподнятие резюме
// @namespace    dmitriy.hh.boost
// @version      1.4.1
// @description  Раз в 4 часа жмёт «Поднять в поиске» на hh.ru. Работает в настоящем браузере с настоящей сессией; переживает сон ноутбука, потому что сверяется с абсолютным временем, а не с таймером.
// @match        https://hh.ru/applicant/*
// @match        https://*.hh.ru/applicant/*
// @icon         https://hh.ru/favicon.ico
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // ─── Настройки ──────────────────────────────────────────────────────────
  const HOUR = 60 * 60 * 1000;
  const MIN_INTERVAL   = 4 * HOUR + 2 * 60 * 1000; // свой троттлинг: 4 ч + 2 мин запаса
  const JITTER_MAX     = 5 * 60 * 1000;            // случайная добавка к моменту попытки
  const RETRY_DELAY    = 30 * 60 * 1000;           // пауза после неудачной попытки
  const LOGIN_DELAY    = 15 * 60 * 1000;           // пауза, если мы разлогинены
  const MIN_RELOAD_GAP = 5 * 60 * 1000;            // страховка от петли перезагрузок
  const TICK           = 30 * 1000;                // как часто сверяемся с часами
  const WAIT_BUTTON    = 25 * 1000;                // сколько ждём появления кнопки
  const WAIT_CONFIRM   = 5 * 1000;                 // сколько ждём отклика hh после одного нажатия
  const MAX_FAILS      = 3;                        // после скольких неудач замолкаем
  const LOG_SIZE       = 25;
  const HYDRATION_DELAY  = 4 * 1000;               // пауза после загрузки: ждём, пока React оживит кнопку
  const CLICK_ATTEMPTS   = 3;                      // сколько раз пробуем нажать за один заход
  const PENDING_RECHECK  = 2 * 60 * 1000;          // через сколько перепроверяем неподтверждённый клик

  // ─── Хранилище ──────────────────────────────────────────────────────────
  const KEY = 'hhBoost:';
  const load = (k, d) => { try { return GM_getValue(KEY + k, d); } catch (e) { return d; } };
  const save = (k, v) => { try { GM_setValue(KEY + k, v); } catch (e) { /* ignore */ } };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const fmt = ts => !ts ? '—' : new Date(ts).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function log(msg, kind) {
    const list = load('log', []);
    list.unshift({ t: Date.now(), msg, kind: kind || 'info' });
    save('log', list.slice(0, LOG_SIZE));
    console.log('[hh-boost]', msg);
  }

  function setStatus(kind, text) {
    save('status', { kind, text, t: Date.now() });
    render();
  }

  // ─── Поиск кнопки ───────────────────────────────────────────────────────
  // Целимся в надпись, а не в data-qa: hh регулярно двигает атрибуты в вёрстке,
  // а текст на кнопке не меняется годами.
  const norm = s => (s || '')
    .replace(/ /g, ' ')
    .replace(/ё/gi, 'е')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const BOOST_TEXTS = [
    /^поднять в поиске$/,
    /^обновить дату$/,
    /поднять в поиске/,
    /обновить дату/,
  ];
  // чтобы не попасть в апселл платного продвижения: «Поднять автоматически» —
  // это платная подписка hh PRO, она занимает место обычной кнопки во время перерыва
  const PAID_MARKERS = /₽|руб|hh pro|купить|оплат|подписк|тариф|в топ|автоматическ/;

  const isBoostLabel = t => !PAID_MARKERS.test(t) && BOOST_TEXTS.some(re => re.test(t));

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function findBoostButton() {
    // У кнопки есть стабильный атрибут data-qa="resume-update-button resume-update-button_actions".
    // Берём его первым, но надпись всё равно проверяем: во время четырёхчасового перерыва
    // hh ставит на то же место платную «Поднять автоматически».
    const byQa = document.querySelector('[data-qa~="resume-update-button"]');
    if (byQa && isVisible(byQa) && isBoostLabel(norm(byQa.textContent))) return byQa;

    const nodes = document.querySelectorAll('button, a, [role="button"], [data-qa]');
    const hits = [];
    for (const el of nodes) {
      const t = norm(el.textContent);
      if (!t || t.length > 40) continue;
      if (PAID_MARKERS.test(t)) continue;
      const rank = BOOST_TEXTS.findIndex(re => re.test(t));
      if (rank < 0) continue;
      if (!isVisible(el)) continue;
      hits.push({ el, rank });
    }
    if (!hits.length) return null;
    // из вложенных совпадений оставляем самое глубокое — это и есть сама кнопка
    const deepest = hits.filter(h => !hits.some(o => o.el !== h.el && h.el.contains(o.el)));
    deepest.sort((a, b) => a.rank - b.rank);
    return deepest.length ? deepest[0].el : null;
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (/disabled/i.test(el.className || '')) return true;
    if (getComputedStyle(el).pointerEvents === 'none') return true;
    return false;
  }

  // ─── Разбор таймера hh ──────────────────────────────────────────────────
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function parseNextTime(raw) {
    const t = norm(raw);

    // «через 3 ч 59 мин»
    let m = t.match(/через\s+(?:(\d+)\s*ч)?\s*(?:(\d+)\s*мин)?/);
    if (m && (m[1] || m[2])) {
      const ms = (+(m[1] || 0)) * HOUR + (+(m[2] || 0)) * 60000;
      if (ms > 0) return Date.now() + ms;
    }

    // «18 сентября в 14:35»
    m = t.match(/(\d{1,2})\s+([а-я]+)\s+в\s+(\d{1,2}):(\d{2})/);
    if (m) {
      const mi = MONTHS.indexOf(m[2]);
      if (mi >= 0) {
        const now = new Date();
        const d = new Date(now.getFullYear(), mi, +m[1], +m[3], +m[4], 0, 0);
        if (d.getTime() < Date.now() - 12 * HOUR) d.setFullYear(now.getFullYear() + 1);
        return d.getTime();
      }
    }

    // «в 14:35» (без \b — в JS он не срабатывает на кириллице)
    m = t.match(/(?:^|[\s,])в\s+(\d{1,2}):(\d{2})(?!\d)/);
    if (m) {
      const d = new Date();
      d.setHours(+m[1], +m[2], 0, 0);
      if (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1);
      return d.getTime();
    }

    return null;
  }

  // Ищем на странице подпись вида «Поднять вручную можно будет в 14:35»
  function findNextTimeHint() {
    const nodes = document.querySelectorAll('div, span, p, small, li, button');
    for (const el of nodes) {
      if (el.children.length > 3) continue;
      const t = norm(el.textContent);
      if (!t || t.length > 140) continue;
      if (!/поднят|обновить дату|следующ/.test(t)) continue;
      if (!/через|\d{1,2}:\d{2}/.test(t)) continue;
      const ts = parseNextTime(t);
      if (ts && ts > Date.now()) return ts;
    }
    return null;
  }

  // ─── Клик ───────────────────────────────────────────────────────────────
  // В песочнице Tampermonkey глобальный `window` — прокси, а не настоящий Window,
  // и Chrome не принимает его в поле view: «Failed to convert value to 'Window'».
  // Поэтому берём окно из документа, а если и оно не подойдёт — строим событие без view.
  function makeEvent(Ctor, type, init) {
    try { return new Ctor(type, init); } catch (e) { /* пробуем без view */ }
    const bare = Object.assign({}, init);
    delete bare.view;
    try { return new Ctor(type, bare); } catch (e) { return null; }
  }

  function click(el) {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, view: document.defaultView,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
      button: 0,
    };
    const fire = type => {
      const ev = makeEvent(MouseEvent, type, base);
      if (ev) el.dispatchEvent(ev);
    };
    // Только mouse-события. PointerEvent убран намеренно: ровно эта тройка,
    // проверенная на живой странице hh, кнопку срабатывает, а с pointerdown/pointerup — нет.
    fire('mousedown');
    fire('mouseup');
    fire('click');
  }

  // После поднятия hh показывает модалку с предложением hh PRO. Для самого скрипта
  // она безвредна: перед следующим поднятием страница всё равно перезагрузится, а клик
  // мы отправляем прямо на элемент, так что перекрытие ему не мешает. Но оставлять её
  // висеть перед глазами не надо — ждём её появления и закрываем.
  const MODAL_SEL = '[role="dialog"], [data-qa*="modal"], [class*="Modal"], [class*="odal-window"]';
  const CLOSE_SEL = '[data-qa*="close"], [data-qa*="Close"], [aria-label*="акрыть"],' +
                    '[title*="акрыть"], [class*="close"], [class*="Close"]';

  async function closeModals() {
    const deadline = Date.now() + 6000;
    let tries = 0;
    while (Date.now() < deadline && tries < 4) {
      const dialog = document.querySelector(MODAL_SEL);
      if (dialog && isVisible(dialog)) {
        tries++;
        const close = dialog.querySelector(CLOSE_SEL);
        if (close) {
          click(close);
        } else {
          const esc = makeEvent(KeyboardEvent, 'keydown',
            { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
          if (esc) {
            document.dispatchEvent(esc);
            dialog.dispatchEvent(esc);
          }
        }
      }
      await sleep(700);
    }
  }

  // Строка «Обновлено 13 сентября 2026 в 14:12» в карточке резюме — самый надёжный
  // признак поднятия: hh переписывает её на текущее время. Не зависит ни от классов,
  // ни от того, останется кнопка на месте или исчезнет.
  function updatedStamp() {
    for (const el of document.querySelectorAll('div, span, p, small')) {
      if (el.children.length) continue;
      const t = norm(el.textContent);
      if (/^обновлено /.test(t)) return t;
    }
    return null;
  }

  // Сообщения, которыми hh отвечает на успешное поднятие. Обе формулировки
  // сняты с живой страницы: «Успешно поднято» на кнопке и «Вы подняли резюме
  // сегодня в 15:14. В следующий раз можно будет через 4 часа.» в карточке.
  const SUCCESS_TEXTS = /успешно поднят|вы подняли резюме|поднято в поиске/;

  function successMessage() {
    const sel = 'div, span, p, button, [role="status"], [role="alert"]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.children.length > 2) continue;
      const t = norm(el.textContent);
      if (t && t.length < 160 && SUCCESS_TEXTS.test(t)) return true;
    }
    return false;
  }

  // Подтверждаем ТОЛЬКО по положительным признакам — по тому, что hh что-то сказал
  // или показал. Исчезновение кнопки успехом не считается: React на hh пересобирает
  // узлы при гидратации и перерисовках, и на этом легко поймать ложное «поднято».
  async function waitConfirmed(stampBefore, hintBefore, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (successMessage()) return true;                  // «Успешно поднято»

      const stamp = updatedStamp();                       // дата резюме переписалась
      if (stampBefore && stamp && stamp !== stampBefore) return true;

      // таймер, которого до клика не было
      const hint = findNextTimeHint();
      if (hint && !hintBefore && hint > Date.now() + 30 * 60 * 1000) return hint;

      if (Date.now() >= deadline) return false;
      await sleep(500);
    }
  }

  // Кнопку ищем заново перед каждой попыткой: React подменяет DOM-узлы,
  // и клик по сохранённой ссылке уходит в никуда.
  async function pressUntilConfirmed(stampBefore, hintBefore) {
    for (let i = 0; i < CLICK_ATTEMPTS; i++) {
      const btn = findBoostButton();
      if (!btn) break;
      if (i > 0) setStatus('work', 'повторяю клик (' + (i + 1) + ')…');

      click(btn);
      const ok = await waitConfirmed(stampBefore, hintBefore, WAIT_CONFIRM);
      if (ok) return ok;

      try { btn.click(); } catch (e) { /* ignore */ }     // нативная активация
      const ok2 = await waitConfirmed(stampBefore, hintBefore, WAIT_CONFIRM);
      if (ok2) return ok2;
    }
    return waitConfirmed(stampBefore, hintBefore, 3000);
  }

  function waitFor(fn, timeout) {
    return new Promise(resolve => {
      const hit = fn();
      if (hit) return resolve(hit);
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      const obs = new MutationObserver(() => { const v = fn(); if (v) finish(v); });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => finish(null), timeout);
    });
  }

  // ─── Планировщик ────────────────────────────────────────────────────────
  function schedule(ts, why) {
    const at = Math.max(ts + Math.floor(Math.random() * JITTER_MAX), Date.now() + 60 * 1000);
    save('nextAt', at);
    setStatus('wait', why);
  }

  function bumpFail(why) {
    const fails = load('failStreak', 0) + 1;
    save('failStreak', fails);
    if (fails >= MAX_FAILS) {
      save('nextAt', 0); // 0 = стоп, чтобы не долбить сайт перезагрузками
      setStatus('error', why + ' — остановился, нужна проверка');
      log('Остановился после ' + fails + ' неудач подряд: ' + why, 'error');
      return true;
    }
    schedule(Date.now() + RETRY_DELAY, why + ' — повтор через 30 мин');
    log(why + ' (попытка ' + fails + ' из ' + MAX_FAILS + ')', 'warn');
    return false;
  }

  function loggedOut() {
    if (/\/account\/login/.test(location.pathname)) return true;
    const pwd = document.querySelector('input[type="password"]');
    return !!(pwd && isVisible(pwd));
  }

  let running = false;

  async function run(force) {
    if (running) return;
    running = true;
    try {
      if (loggedOut()) {
        save('nextAt', Date.now() + LOGIN_DELAY);
        setStatus('warn', 'не авторизован на hh.ru — войди в аккаунт');
        log('Сессия слетела: нужно войти на hh.ru', 'warn');
        return;
      }

      // Разбираем висящую перепроверку: в прошлый заход клик не подтвердился,
      // и мы специально перезагрузили страницу, чтобы узнать правду у сервера.
      const pending = load('pendingCheck', 0);
      if (pending) {
        save('pendingCheck', 0);
        const stillThere = findBoostButton();
        if (!stillThere || isDisabled(stillThere)) {
          save('lastBoostAt', pending);
          save('failStreak', 0);
          schedule(findNextTimeHint() || pending + MIN_INTERVAL, 'поднятие подтвердилось после перезагрузки');
          log('Поднятие подтвердилось после перезагрузки', 'ok');
          return;
        }
        const fails = load('failStreak', 0) + 1;
        save('failStreak', fails);
        log('Кнопка снова активна — прошлый клик не сработал (' + fails + ' из ' + MAX_FAILS + ')', 'warn');
        if (fails >= MAX_FAILS) {
          save('nextAt', 0);
          setStatus('error', 'клик не срабатывает — остановился, нужна проверка');
          return;
        }
        // иначе не выходим: сразу пробуем нажать ещё раз на этой же странице
      }

      const last = load('lastBoostAt', 0);
      if (!force && !pending && last && Date.now() - last < MIN_INTERVAL) {
        schedule(last + MIN_INTERVAL, 'свои 4 часа с прошлого поднятия ещё не прошли');
        return;
      }

      setStatus('work', 'ищу кнопку…');

      // Если hh прямо сейчас показывает «Поднять вручную можно сегодня в 19:14»,
      // ждать появления кнопки бессмысленно — её не будет ещё несколько часов.
      if (!findBoostButton()) {
        const hint = findNextTimeHint();
        if (hint) {
          save('failStreak', 0);
          schedule(hint, 'таймер hh ещё идёт');
          return;
        }
      }

      const btn = await waitFor(findBoostButton, WAIT_BUTTON);

      if (!btn) {
        // Во время перерыва кнопки просто нет: hh пишет «Поднять вручную можно сегодня в 19:14»
        // и подставляет на её место платную «Поднять автоматически». Это не поломка.
        const hint = findNextTimeHint();
        if (hint) {
          save('failStreak', 0);
          schedule(hint, 'таймер hh ещё идёт');
          return;
        }
        if (last && Date.now() - last < 4 * HOUR) {
          save('failStreak', 0);
          schedule(last + MIN_INTERVAL, 'идёт четырёхчасовой перерыв hh');
          return;
        }
        bumpFail('кнопка «Поднять в поиске» не найдена');
        return;
      }

      if (isDisabled(btn)) {
        save('failStreak', 0);
        schedule(findNextTimeHint() || Date.now() + 4 * HOUR, 'таймер hh ещё идёт');
        return;
      }

      setStatus('work', 'жму кнопку…');
      const stampBefore = updatedStamp();
      const hintBefore = findNextTimeHint();

      const ok = await pressUntilConfirmed(stampBefore, hintBefore);

      // Модалка с hh PRO выскакивает уже после успеха, поэтому закрываем её после проверки.
      await closeModals();
      if (ok) {
        const now = Date.now();
        save('lastBoostAt', now);
        save('failStreak', 0);
        const next = typeof ok === 'number' ? ok : now + 4 * HOUR;
        schedule(Math.max(next, now + MIN_INTERVAL - 2 * 60 * 1000), 'поднято, ждём следующего окна');
        log('Резюме поднято', 'ok');
      } else {
        // Не подтвердилось — но это ещё не значит, что не сработало. Правду знает
        // только свежая страница: перезагрузимся через пару минут и посмотрим,
        // активна ли кнопка. Неудачу засчитаем уже там.
        save('pendingCheck', Date.now());
        save('nextAt', Date.now() + PENDING_RECHECK); // без разброса: это диагностика, а не поднятие
        setStatus('warn', 'клик без подтверждения — перепроверю на свежей странице');
        log('Клик не подтвердился — перепроверю после перезагрузки', 'warn');
      }
    } catch (e) {
      console.error('[hh-boost]', e);
      bumpFail('ошибка скрипта: ' + (e && e.message ? e.message : e));
    } finally {
      running = false;
      render();
    }
  }

  // ─── Часы ───────────────────────────────────────────────────────────────
  // Никаких setTimeout на 4 часа: во сне ноутбука таймеры замирают и уезжают.
  // Сверяемся с абсолютным временем — тогда пропущенный слот отрабатывает
  // сразу после пробуждения.
  function tick() {
    // профиль hh — SPA на React: если он перерисовал body и выкинул наш бейдж, вешаем заново
    if (host && !host.isConnected) { shadow = null; ui = {}; buildBadge(); }
    render();
    const at = load('nextAt', 0);
    if (!at || Date.now() < at) return;
    const lastReload = load('lastReloadAt', 0);
    if (Date.now() - lastReload < MIN_RELOAD_GAP) return;
    save('lastReloadAt', Date.now());
    log('Перезагружаю страницу — подошло время поднятия');
    location.reload();
  }

  function startClock() {
    setInterval(tick, TICK);
    const wake = () => setTimeout(tick, 1000);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
  }

  // ─── Бейдж ──────────────────────────────────────────────────────────────
  const COLORS = { ok: '#3ecf8e', wait: '#8ab4f8', work: '#f7c948', warn: '#f7c948', error: '#ff6b6b' };
  let host = null, shadow = null, ui = {};

  function mk(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    }
    if (kids) for (const c of kids) n.appendChild(c);
    return n;
  }

  function buildBadge() {
    if (shadow) return;
    host = document.createElement('div');
    host.id = 'hh-boost-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;';
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = [
      ':host,*{box-sizing:border-box}',
      '.p{font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
      'background:#1c1f26;color:#e6e8ec;border:1px solid #2f3540;border-radius:10px;',
      'box-shadow:0 6px 24px rgba(0,0,0,.28);width:276px;overflow:hidden}',
      '.h{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#22262f;cursor:pointer;user-select:none}',
      '.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}',
      '.t{font-weight:600;letter-spacing:.2px;flex:1}',
      '.chev{opacity:.5;font-size:11px}',
      '.b{padding:10px 11px;display:grid;gap:7px}',
      '.row{display:flex;justify-content:space-between;gap:10px}',
      '.k{color:#98a2b3}',
      '.v{text-align:right}',
      '.st{color:#c9ced8}',
      '.btns{display:flex;gap:6px;margin-top:2px}',
      'button{flex:1;font:inherit;padding:6px 8px;border-radius:7px;border:1px solid #39404d;',
      'background:#2a303a;color:#e6e8ec;cursor:pointer}',
      'button:hover{background:#333a46}',
      '.log{max-height:168px;overflow:auto;border-top:1px solid #2f3540;padding:8px 11px;display:grid;gap:5px}',
      '.le{display:flex;gap:7px}',
      '.lt{color:#7d8698;flex:0 0 auto;font-variant-numeric:tabular-nums}',
      '.hidden{display:none}',
    ].join('');

    // Разметку собираем через createElement, а не innerHTML: на страницах
    // с Trusted Types присвоение innerHTML бросает исключение, и бейдж молча не появляется.
    ui.dot = mk('span', { class: 'dot' });
    ui.chev = mk('span', { class: 'chev', text: '▾' });
    const head = mk('div', { class: 'h' }, [
      ui.dot,
      mk('span', { class: 't', text: 'hh · автоподнятие' }),
      ui.chev,
    ]);

    ui.status = mk('div', { class: 'st', text: '…' });
    ui.next = mk('span', { class: 'v', text: '—' });
    ui.last = mk('span', { class: 'v', text: '—' });
    ui.btnNow = mk('button', { text: 'Поднять сейчас' });
    ui.btnLog = mk('button', { text: 'Журнал' });
    ui.log = mk('div', { class: 'log hidden' });
    ui.body = mk('div', null, [
      mk('div', { class: 'b' }, [
        ui.status,
        mk('div', { class: 'row' }, [mk('span', { class: 'k', text: 'Следующая попытка' }), ui.next]),
        mk('div', { class: 'row' }, [mk('span', { class: 'k', text: 'Последнее поднятие' }), ui.last]),
        mk('div', { class: 'btns' }, [ui.btnNow, ui.btnLog]),
      ]),
      ui.log,
    ]);

    shadow.appendChild(style);
    shadow.appendChild(mk('div', { class: 'p' }, [head, ui.body]));

    head.addEventListener('click', () => {
      save('collapsed', !load('collapsed', false));
      render();
    });
    ui.btnNow.addEventListener('click', e => {
      e.stopPropagation();
      save('failStreak', 0); // ручной запуск снимает «остановился после 3 неудач»
      log('Ручной запуск');
      run(true);
    });
    ui.btnLog.addEventListener('click', e => {
      e.stopPropagation();
      save('logOpen', !load('logOpen', false));
      render();
    });
  }

  function render() {
    if (!shadow) return;
    const st = load('status', { kind: 'wait', text: 'запускаюсь…' });
    const collapsed = load('collapsed', false);
    const logOpen = load('logOpen', false);
    const nextAt = load('nextAt', 0);

    ui.dot.style.background = COLORS[st.kind] || COLORS.wait;
    ui.chev.textContent = collapsed ? '▸' : '▾';
    ui.body.className = collapsed ? 'hidden' : '';
    ui.status.textContent = st.text;
    ui.next.textContent = nextAt ? fmt(nextAt) : 'остановлено';
    ui.last.textContent = fmt(load('lastBoostAt', 0));

    ui.log.className = 'log' + (logOpen ? '' : ' hidden');
    if (logOpen) {
      ui.log.textContent = '';
      const items = load('log', []);
      if (!items.length) {
        ui.log.appendChild(mk('div', { class: 'le' }, [mk('span', { text: 'пусто' })]));
      }
      for (const e of items) {
        ui.log.appendChild(mk('div', { class: 'le' }, [
          mk('span', { class: 'lt', text: new Date(e.t).toLocaleString('ru-RU',
            { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
          mk('span', { text: String(e.msg) }),
        ]));
      }
    }
  }

  // ─── Старт ──────────────────────────────────────────────────────────────
  console.log('[hh-boost] v1.4.1 загружен:', location.href);
  try {
    buildBadge();
    render();
    startClock();

    // hh отдаёт страницу с сервера уже отрисованной, а React подключает обработчики позже.
    // Кнопка при этом видна и выглядит рабочей, но клик по ней уходит в пустоту — поэтому
    // ждём полной загрузки и даём странице ещё несколько секунд на гидратацию.
    const start = () => {
      setStatus('wait', 'жду, пока страница оживёт…');
      setTimeout(() => run(false), HYDRATION_DELAY);
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
  } catch (e) {
    console.error('[hh-boost] не смог стартовать:', e);
  }
})();