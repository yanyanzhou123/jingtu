(function () {
  const $ = (id) => document.getElementById(id);
  const setup = $('yt-exam-setup');
  const chatWrap = $('yt-exam-chat-wrap');
  const loadingEl = $('yt-exam-loading');
  const skeletonEl = $('yt-exam-skeleton');
  const fieldsEl = $('yt-exam-fields');
  const startBtn = $('yt-exam-start');
  const modSel = $('yt-mod');
  const lessonSel = $('yt-lesson');
  const chatEl = $('yt-exam-chat');
  const input = $('yt-exam-input');
  const msg = $('yt-exam-msg');
  const status = $('yt-exam-status');
  const meta = $('yt-exam-meta');

  const CACHE_KEY = 'jx-catalog-lite-v2';

  let catalog = null;
  let sessionId = '';
  let busy = false;
  let ready = false;

  function show(el, text, isErr) {
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('yt-msg--err', !!isErr);
  }

  function setChatting(on) {
    document.querySelector('.yt-page')?.classList.toggle('is-chatting', !!on);
  }

  function setLoading(on, note) {
    setup?.classList.toggle('is-loading', !!on);
    if (loadingEl) {
      loadingEl.hidden = !on;
      const copy = loadingEl.querySelector('.yt-loading-copy p');
      if (copy && note) copy.textContent = note;
    }
    if (skeletonEl) skeletonEl.hidden = !on;
    if (fieldsEl) fieldsEl.classList.toggle('yt-hidden', !!on);
  }

  function setReady() {
    ready = true;
    setLoading(false);
    if (modSel) modSel.disabled = false;
    if (lessonSel) lessonSel.disabled = false;
    if (startBtn) startBtn.disabled = false;
    show(msg, '', false);
  }

  function appendBubble(role, text) {
    const div = document.createElement('div');
    div.className = 'yt-bubble yt-bubble--' + (role === 'user' ? 'user' : 'assistant');
    const metaLine = document.createElement('span');
    metaLine.className = 'yt-bubble-meta';
    metaLine.textContent = role === 'user' ? '学员' : '堪布';
    const body = document.createElement('div');
    body.textContent = text;
    div.appendChild(metaLine);
    div.appendChild(body);
    chatEl.appendChild(div);
    requestAnimationFrame(() => {
      div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败 ' + res.status);
    return data;
  }

  function lessonsOfModule(slug) {
    const mod = (catalog?.modules || []).find((m) => m.slug === slug);
    if (!mod) return [];
    const rows = [];
    for (const ch of mod.chapters || []) {
      for (const les of ch.lessons || []) {
        if (les.hasText === false) continue;
        // lite 有 hasText；旧缓存若无该字段则照常列出
        if (les.hasText === undefined) {
          const text = typeof les.text === 'string' ? les.text.trim() : '';
          if (!text && !(les.segments || []).length) continue;
        }
        rows.push({
          slug: les.slug,
          title: les.title || les.slug,
          chapter: ch.title || '',
        });
      }
    }
    return rows;
  }

  function fillModules() {
    modSel.innerHTML = '';
    for (const m of catalog?.modules || []) {
      if (m.status === 'coming') continue;
      const opt = document.createElement('option');
      opt.value = m.slug;
      opt.textContent = m.title || m.slug;
      modSel.appendChild(opt);
    }
    fillLessons();
  }

  function fillLessons() {
    lessonSel.innerHTML = '';
    const rows = lessonsOfModule(modSel.value);
    if (!rows.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（该模块暂无正文课）';
      lessonSel.appendChild(opt);
      return;
    }
    for (const r of rows) {
      const opt = document.createElement('option');
      opt.value = r.slug;
      opt.textContent = (r.chapter ? r.chapter + ' · ' : '') + r.title;
      lessonSel.appendChild(opt);
    }
  }

  function applyCatalog(data) {
    catalog = data;
    fillModules();
    setReady();
  }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.modules)) return null;
      return data;
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {
      // ignore quota
    }
  }

  async function loadCatalog() {
    const cached = readCache();
    if (cached) {
      applyCatalog(cached);
    } else {
      setLoading(true, '稍候即可选择模块与课次');
    }

    const res = await fetch('/api/catalog?lite=1');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '课表加载失败');
    writeCache(data);
    applyCatalog(data);
  }

  async function startExam() {
    if (busy || !ready) return;
    const moduleSlug = modSel.value;
    const lessonSlug = lessonSel.value;
    if (!moduleSlug || !lessonSlug) {
      show(msg, '请选择有正文的课次', true);
      return;
    }
    busy = true;
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '拟题中…';
    }
    show(msg, '堪布正在依原文拟题，通常需要数秒…', false);
    try {
      const data = await api('/api/yantao/exam', {
        action: 'start',
        moduleSlug,
        lessonSlug,
      });
      sessionId = data.sessionId;
      chatEl.innerHTML = '';
      appendBubble('assistant', data.reply);
      meta.textContent = data.lessonTitle + ' · 共 ' + data.questionCount + ' 题';
      setup.classList.add('yt-hidden');
      chatWrap.classList.remove('yt-hidden');
      setChatting(true);
      show(msg, '', false);
      input.focus();
    } catch (e) {
      show(msg, e.message || String(e), true);
    } finally {
      busy = false;
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = '开始考问';
      }
    }
  }

  async function send(message) {
    if (busy || !sessionId) return;
    const text = String(message || '').trim();
    if (!text) return;
    busy = true;
    input.value = '';
    appendBubble('user', text);
    show(status, '堪布审思中…', false);
    try {
      const data = await api('/api/yantao/exam', {
        action: 'reply',
        sessionId,
        message: text,
      });
      appendBubble('assistant', data.reply);
      if (data.phase === 'done') {
        show(status, '本次考问已结束。', false);
        input.disabled = true;
      } else {
        show(status, '第 ' + (data.currentIndex + 1) + ' / ' + data.questionCount + ' 题', false);
      }
    } catch (e) {
      show(status, e.message || String(e), true);
    } finally {
      busy = false;
    }
  }

  modSel?.addEventListener('change', fillLessons);
  startBtn?.addEventListener('click', () => startExam());
  $('yt-exam-send')?.addEventListener('click', () => send(input.value));
  $('yt-exam-next')?.addEventListener('click', () => send('请下一题'));
  $('yt-exam-reset')?.addEventListener('click', () => {
    sessionId = '';
    input.disabled = false;
    chatWrap.classList.add('yt-hidden');
    setup.classList.remove('yt-hidden');
    setChatting(false);
    show(status, '', false);
    if (ready) setReady();
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send(input.value);
    }
  });

  loadCatalog().catch((e) => {
    setLoading(false);
    fieldsEl?.classList.remove('yt-hidden');
    show(msg, e.message || String(e), true);
  });
})();
