// Диагностика вёрстки hh.ru.
// Вставить в консоль (Cmd+Option+J) на странице https://hh.ru/applicant/profile/me
//
// Что делает: снимает состояние карточки резюме, отправляет ровно такой же
// синтетический клик, как userscript, через 5 секунд снимает состояние ещё раз
// и кладёт отчёт в буфер обмена. Ничего не меняет, кроме самого нажатия кнопки.

(() => {
  const norm = s => (s || '').replace(/ /g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s || '').length > n ? s.slice(0, n) + ' …[обрезано]' : s;

  const btn = [...document.querySelectorAll('button, a, [role="button"], [data-qa]')]
    .filter(e => /^поднять в поиске$/.test(norm(e.textContent)))
    .filter(e => !e.querySelector('button, a, [role="button"]'))[0];

  const upd = [...document.querySelectorAll('div, span, p, small')]
    .filter(e => !e.children.length && /^обновлено /.test(norm(e.textContent)))[0];

  const card = btn
    ? (btn.closest('[data-qa], section, article, li') || (btn.parentElement && btn.parentElement.parentElement))
    : null;

  const snap = when => ({
    когда: when,
    обновлено: upd ? upd.textContent.trim() : '(строка не найдена)',
    кнопка_на_месте: btn ? document.contains(btn) : false,
    кнопка_disabled: btn ? !!(btn.disabled || btn.getAttribute('aria-disabled') === 'true') : null,
    класс_кнопки: btn ? btn.className : null,
    диалоги_и_всплывашки: [...document.querySelectorAll(
      '[role="dialog"], [class*="odal"], [role="status"], [role="alert"], [class*="otification"]')]
      .map(e => cut(e.textContent.trim().replace(/\s+/g, ' '), 120)).filter(Boolean).slice(0, 5),
    текст_карточки: card ? cut(card.textContent.replace(/\s+/g, ' ').trim(), 500) : null,
  });

  const before = snap('до клика');
  const report = {
    адрес: location.href,
    кнопка_найдена: !!btn,
    тег: btn ? btn.tagName : null,
    html_кнопки: btn ? cut(btn.outerHTML, 800) : null,
    html_блока_с_кнопками: btn && btn.parentElement ? cut(btn.parentElement.outerHTML, 1500) : null,
    html_строки_обновлено: upd ? cut(upd.outerHTML, 300) : null,
    до: before,
  };

  const finish = () => {
    console.log(report);
    try {
      copy(JSON.stringify(report, null, 2));
      console.log('%c[диагностика] отчёт скопирован в буфер обмена', 'color:#3ecf8e');
    } catch (e) {
      console.log('[диагностика] copy() недоступен — разверни объект выше и скопируй вручную');
    }
  };

  if (!btn) {
    report.вывод = 'Кнопка «Поднять в поиске» на странице не найдена — возможно, идёт таймер hh.';
    return finish();
  }

  // тот же синтетический клик, что шлёт userscript
  const r = btn.getBoundingClientRect();
  const init = {
    bubbles: true, cancelable: true, view: document.defaultView,
    clientX: Math.round(r.left + r.width / 2),
    clientY: Math.round(r.top + r.height / 2),
    button: 0,
  };
  const fire = type => {
    let ev;
    try {
      ev = new MouseEvent(type, init);
    } catch (e) {
      const bare = Object.assign({}, init);
      delete bare.view;
      ev = new MouseEvent(type, bare);
    }
    btn.dispatchEvent(ev);
  };
  fire('mousedown');
  fire('mouseup');
  fire('click');
  console.log('[диагностика] клик отправлен, жду 5 секунд…');

  setTimeout(() => {
    report.после = snap('через 5 секунд');
    report.дата_изменилась = before.обновлено !== report.после.обновлено;
    report.вывод = report.дата_изменилась
      ? 'Синтетический клик РАБОТАЕТ — дата резюме обновилась.'
      : 'Синтетический клик не дал видимого эффекта за 5 секунд.';
    finish();
  }, 5000);
})();
