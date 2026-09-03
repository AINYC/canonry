/**
 * The one place the timing is written. The script below rewrites the query
 * hint's text on every keystroke, so a suffix left only in the server markup
 * would survive until the visitor types and then silently disappear.
 */
export const QUERY_HINT_SUFFIX = 'Takes about 45 seconds.'

/** Client-side enhancement only. The page remains usable with native forms and details. */
export const brandPerceptionClientScript = `
(() => {
  const queries = document.querySelector('[data-query-hint]');
  const queryInput = document.getElementById('queries-input');
  if (queries && queryInput) {
    const max = Number(queries.dataset.max || 3);
    const update = () => {
      const used = queryInput.value.split('\\n').map((line) => line.trim()).filter((line) => line.length >= 3).length;
      const kept = Math.min(used, max);
      const rest = max - kept;
      const counts = kept === 0
        ? 'Add up to ' + max + '. We generate the rest.'
        : rest === 0
        ? 'Using your ' + kept + '. We generate none.'
        : 'Using your ' + kept + '. We generate the other ' + rest + '.';
      // Interpolated at module load so the server markup and every rewrite of
      // this line read one constant.
      queries.textContent = counts + ' ' + ${JSON.stringify(QUERY_HINT_SUFFIX)};
    };
    queryInput.addEventListener('input', update);
    update();
  }

  const form = document.querySelector('[data-domain-check-form]');
  if (form) {
    const submit = form.querySelector('[data-domain-submit]');
    const busy = form.querySelector('[data-form-busy]');
    const checking = document.querySelector('[data-checking]');

    const markBusy = () => {
      form.setAttribute('aria-busy', 'true');
      if (submit instanceof HTMLButtonElement) {
        submit.disabled = true;
        submit.setAttribute('aria-disabled', 'true');
        submit.textContent = 'Starting…';
      }
      if (busy) {
        busy.hidden = false;
        busy.classList.remove('is-error');
        busy.textContent = 'Starting check…';
      }
    };

    // Without the waiting view there is nothing to enhance: fall back to the
    // native POST, which still works, just with a blocked browser.
    if (!checking) {
      form.addEventListener('submit', markBusy);
    } else {
      const elapsedEl = checking.querySelector('[data-checking-elapsed]');
      const domainEl = checking.querySelector('[data-checking-domain]');
      const queriesEl = checking.querySelector('[data-checking-queries]');
      const hero = document.querySelector('[data-hero]');

      const restore = (message) => {
        checking.hidden = true;
        if (hero) hero.hidden = false;
        form.removeAttribute('aria-busy');
        if (submit instanceof HTMLButtonElement) {
          submit.disabled = false;
          submit.removeAttribute('aria-disabled');
          submit.textContent = submit.dataset.label || 'Check a brand';
        }
        if (busy) {
          busy.hidden = false;
          // A failure and "Starting check…" must not be the same grey line, or
          // hiding the waiting view reads as the page bouncing back to the form
          // with nothing said, while the reason sits on screen unnoticed.
          busy.classList.add('is-error');
          busy.textContent = message;
        }
        // A Turnstile token is redeemed exactly once. The page is still here
        // after a failure, so the spent token has to be replaced before the
        // visitor can try again.
        if (window.turnstile && typeof window.turnstile.reset === 'function') {
          try { window.turnstile.reset(); } catch (_) { /* widget absent */ }
        }
      };

      form.addEventListener('submit', (event) => {
        const data = new FormData(form);
        const domain = String(data.get('domain') || '').trim();
        if (!domain) return;
        event.preventDefault();
        markBusy();

        if (domainEl) domainEl.textContent = domain;
        const typed = String(data.get('queries') || '')
          .split('\\n').map((line) => line.trim()).filter((line) => line.length >= 3).slice(0, 3);
        if (queriesEl) {
          queriesEl.textContent = '';
          for (const question of typed) {
            const item = document.createElement('li');
            item.textContent = question;
            queriesEl.appendChild(item);
          }
          queriesEl.hidden = typed.length === 0;
        }
        if (hero) hero.hidden = true;
        checking.hidden = false;

        const started = Date.now();
        const tick = setInterval(() => {
          if (elapsedEl) elapsedEl.textContent = Math.round((Date.now() - started) / 1000) + 's';
        }, 1000);

        fetch(form.dataset.jsonAction || '/api/checks', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            domain: domain,
            queries: typed,
            turnstileToken: data.get('cf-turnstile-response') || null,
          }),
        })
          .then((response) => response.json().then((body) => ({ ok: response.ok, body: body })))
          .then((result) => {
            clearInterval(tick);
            const id = result.body && result.body.check && result.body.check.id;
            if (result.ok && id) {
              location.href = '/?check=' + encodeURIComponent(id);
              return;
            }
            const error = result.body && result.body.error;
            restore((error && error.message) || 'The check could not be started. Try again.');
          })
          .catch(() => {
            clearInterval(tick);
            restore('The check could not be reached. Try again.');
          });
      });
    }
  }
})();
`
