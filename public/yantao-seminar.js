(function () {
  const $ = (id) => document.getElementById(id);
  const setup = $('yt-sem-setup');
  const chatWrap = $('yt-sem-chat-wrap');
  const topicEl = $('yt-topic');
  const chatEl = $('yt-sem-chat');
  const input = $('yt-sem-input');
  const msg = $('yt-sem-msg');
  const status = $('yt-sem-status');
  const meta = $('yt-sem-meta');

  let sessionId = '';
  let busy = false;

  function show(el, text, isErr) {
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('yt-msg--err', !!isErr);
  }

  function setChatting(on) {
    document.querySelector('.yt-page')?.classList.toggle('is-chatting', !!on);
  }

  function appendBubble(role, text) {
    const div = document.createElement('div');
    div.className = 'yt-bubble yt-bubble--' + (role === 'user' ? 'user' : 'assistant');
    const metaLine = document.createElement('span');
    metaLine.className = 'yt-bubble-meta';
    metaLine.textContent = role === 'user' ? '学员' : '圆桌';
    const body = document.createElement('div');
    body.textContent = text;
    div.appendChild(metaLine);
    div.appendChild(body);
    chatEl.appendChild(div);
    requestAnimationFrame(() => {
      div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  async function api(body) {
    const res = await fetch('/api/yantao/seminar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败 ' + res.status);
    return data;
  }

  async function start() {
    if (busy) return;
    const topic = String(topicEl.value || '').trim();
    if (!topic) {
      show(msg, '请填写议题', true);
      return;
    }
    busy = true;
    show(msg, '主持人正在邀集嘉宾…', false);
    try {
      const data = await api({ action: 'start', topic });
      sessionId = data.sessionId;
      chatEl.innerHTML = '';
      appendBubble('assistant', data.reply);
      meta.textContent = '议题：' + topic;
      setup.classList.add('yt-hidden');
      chatWrap.classList.remove('yt-hidden');
      setChatting(true);
      show(msg, '', false);
      input.focus();
    } catch (e) {
      show(msg, e.message || String(e), true);
    } finally {
      busy = false;
    }
  }

  async function send(message) {
    if (busy || !sessionId) return;
    let text = String(message || '').trim();
    if (!text) return;

    if (text === '引入新人物') {
      const name = window.prompt('希望邀请哪位佛学人物加入？');
      if (!name || !String(name).trim()) return;
      text = '引入新人物：' + String(name).trim();
    }

    busy = true;
    input.value = '';
    appendBubble('user', text);
    show(status, '圆桌进行中…', false);
    try {
      const data = await api({ action: 'command', sessionId, message: text });
      appendBubble('assistant', data.reply);
      if (data.done) {
        show(status, '本场圆桌已结束。', false);
        input.disabled = true;
      } else {
        show(status, '', false);
      }
    } catch (e) {
      show(status, e.message || String(e), true);
    } finally {
      busy = false;
    }
  }

  $('yt-sem-start')?.addEventListener('click', () => start());
  $('yt-sem-send')?.addEventListener('click', () => send(input.value));
  $('yt-sem-reset')?.addEventListener('click', () => {
    sessionId = '';
    input.disabled = false;
    chatWrap.classList.add('yt-hidden');
    setup.classList.remove('yt-hidden');
    setChatting(false);
    show(status, '', false);
  });
  document.querySelectorAll('#yt-sem-chips .yt-chip').forEach((btn) => {
    btn.addEventListener('click', () => send(btn.getAttribute('data-cmd') || ''));
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send(input.value);
    }
  });
})();
