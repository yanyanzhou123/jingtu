(() => {
  const body = document.getElementById('app-body');
  if (!body) return;

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `请求失败 ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function progressMap(items) {
    const map = new Map();
    for (const it of items || []) {
      map.set(`${it.moduleSlug}/${it.lessonSlug}`, it);
    }
    return map;
  }

  function renderAuth(mode = 'login') {
    body.innerHTML = `
      <div class="app-auth">
        <div class="app-auth-tabs" role="tablist">
          <button type="button" data-mode="login" class="${mode === 'login' ? 'is-active' : ''}">登录</button>
          <button type="button" data-mode="register" class="${mode === 'register' ? 'is-active' : ''}">注册</button>
        </div>
        <form class="app-form" id="app-auth-form">
          <label>用户名
            <input name="username" autocomplete="username" required minlength="3" maxlength="32" placeholder="至少 3 个字符" />
          </label>
          <label>密码
            <input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="6" maxlength="72" placeholder="至少 6 位" />
          </label>
          <button type="submit">${mode === 'login' ? '登录' : '注册并开始学习'}</button>
          <p class="app-msg" id="app-auth-msg" hidden></p>
        </form>
      </div>
      <p class="app-install">提示：用手机浏览器打开本页后，可「添加到主屏幕」，当作简易学习 App 使用。</p>`;

    body.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => renderAuth(btn.getAttribute('data-mode')));
    });

    const form = body.querySelector('#app-auth-form');
    const msg = body.querySelector('#app-auth-msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      msg.hidden = true;
      try {
        const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
        await api(path, {
          method: 'POST',
          body: JSON.stringify({
            username: fd.get('username'),
            password: fd.get('password'),
          }),
        });
        await boot();
      } catch (err) {
        msg.hidden = false;
        msg.className = 'app-msg is-error';
        msg.textContent = err.message || String(err);
      }
    });
  }

  function lessonHref(mod, slug, tab) {
    const qs = new URLSearchParams({ mod, id: slug });
    if (tab) qs.set('tab', tab);
    return `/mod/learn/?${qs.toString()}`;
  }

  function renderHome(user, catalog, progress) {
    const map = progressMap(progress.items);
    const recent = progress.recent;
    let continueHtml = '';
    if (recent) {
      let title = `${recent.moduleSlug} / ${recent.lessonSlug}`;
      const found = typeof JX?.findLesson === 'function'
        ? JX.findLesson(catalog, recent.moduleSlug, recent.lessonSlug)
        : null;
      if (found) title = `${found.mod.title} · ${found.lesson.title}`;
      continueHtml = `
        <section class="app-continue">
          <h2>继续学习</h2>
          <p>${escapeHtml(title)}${recent.completed ? '（已学完）' : ''}</p>
          <a class="app-btn app-btn--solid" href="${lessonHref(recent.moduleSlug, recent.lessonSlug, recent.lastTab)}">接着学</a>
        </section>`;
    }

    const mods = (catalog.modules || []).filter((m) => (m.chapters || []).some((ch) => (ch.lessons || []).length));
    const modulesHtml = mods
      .map((mod) => {
        const lessons = [];
        for (const ch of mod.chapters || []) {
          for (const les of ch.lessons || []) {
            lessons.push({ chapter: ch.title, ...les });
          }
        }
        if (!lessons.length) return '';
        const list = lessons
          .map((les) => {
            const key = `${mod.slug}/${les.slug}`;
            const p = map.get(key);
            let badge = '';
            if (p?.completed) badge = '<span class="app-badge app-badge--done">已学完</span>';
            else if (p && p.positionSec > 0) badge = `<span class="app-badge">播至 ${Math.floor(p.positionSec)}s</span>`;
            return `<li><a href="${lessonHref(mod.slug, les.slug, p?.lastTab)}"><span class="app-lesson-title">${escapeHtml(les.title)}</span>${badge}</a></li>`;
          })
          .join('');
        return `<section class="app-mod"><h2>${escapeHtml(mod.title)}</h2><ul class="app-lesson-list">${list}</ul></section>`;
      })
      .join('');

    body.innerHTML = `
      <div class="app-home-head">
        <p>你好，<strong>${escapeHtml(user.username)}</strong></p>
        <div class="app-home-actions">
          <a class="app-btn" href="/xuexiu/">学修目录</a>
          <button type="button" class="app-btn" id="app-logout">退出</button>
        </div>
      </div>
      ${continueHtml}
      ${modulesHtml || '<p>暂无课程，请稍后再来。</p>'}
      <p class="app-install">手机浏览器可将本页「添加到主屏幕」，方便每日打开学习。</p>`;

    body.querySelector('#app-logout')?.addEventListener('click', async () => {
      try {
        await api('/api/auth/logout', { method: 'POST', body: '{}' });
      } catch (_) {}
      renderAuth('login');
    });
  }

  async function boot() {
    body.innerHTML = '<p class="app-loading">加载中…</p>';
    try {
      for (let i = 0; i < 50 && typeof JX?.fetchCatalog !== 'function'; i++) {
        await new Promise((r) => setTimeout(r, 40));
      }
      const me = await api('/api/auth/me');
      const [catalog, progress] = await Promise.all([
        JX.fetchCatalog(),
        api('/api/progress'),
      ]);
      renderHome(me.user, catalog, progress);
    } catch (e) {
      if (e.status === 401) renderAuth('login');
      else {
        body.innerHTML = `<p class="app-msg is-error">${escapeHtml(e.message || e)}</p>`;
        renderAuth('login');
      }
    }
  }

  boot();
})();
