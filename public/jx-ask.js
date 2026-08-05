(() => {
  if (window.__jxAskMounted) return;
  window.__jxAskMounted = true;

  const path = location.pathname || '';
  if (path.startsWith('/ops')) return;

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function currentContext() {
    const qs = new URLSearchParams(location.search);
    return {
      moduleSlug: qs.get('mod') || '',
      lessonSlug: qs.get('id') || '',
    };
  }

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'jx-ask-fab';
  fab.setAttribute('aria-label', '打开学修解惑');
  fab.innerHTML = '<span class="jx-ask-fab-label">学修解惑</span>';

  const panel = document.createElement('div');
  panel.className = 'jx-ask-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="jx-ask-head">
      <strong>学修解惑</strong>
      <button type="button" class="jx-ask-close" aria-label="关闭">×</button>
    </div>
    <div class="jx-ask-body">
      <p class="jx-ask-hint">先检索相关原文，再据原文归纳。回答仅供参考，请以原文与录音为准。</p>
      <textarea class="jx-ask-input" maxlength="500" placeholder="请输入你的问题，例如：什么是暇满人身？"></textarea>
      <div class="jx-ask-actions">
        <button type="button" class="jx-ask-submit">提问</button>
      </div>
      <p class="jx-ask-error" hidden></p>
      <div class="jx-ask-answer" hidden></div>
      <p class="jx-ask-foot">AI 辅助学修，不能替代依止与如理闻思。</p>
    </div>
  `;

  const input = panel.querySelector('.jx-ask-input');
  const submit = panel.querySelector('.jx-ask-submit');
  const errEl = panel.querySelector('.jx-ask-error');
  const answerEl = panel.querySelector('.jx-ask-answer');
  const closeBtn = panel.querySelector('.jx-ask-close');

  function setOpen(open) {
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    fab.classList.toggle('is-open', open);
    if (open) setTimeout(() => input.focus(), 50);
  }

  fab.addEventListener('click', () => setOpen(panel.hidden));
  closeBtn.addEventListener('click', () => setOpen(false));

  function renderAnswer(data) {
    const passages = Array.isArray(data.passages) ? data.passages : [];
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const summary = String(data.summary || data.answer || '').trim();

    let html = '';

    if (passages.length) {
      html += `<section class="jx-ask-section">
        <h4>一、相关原文</h4>
        ${passages
          .map((p) => {
            const excerpts = (p.excerpts || []).map((ex) => `<blockquote>${escapeHtml(ex)}</blockquote>`).join('');
            return `<div class="jx-ask-passage">
              <div class="jx-ask-label">${escapeHtml(p.label)}</div>
              ${excerpts}
            </div>`;
          })
          .join('')}
      </section>`;
    }

    if (sources.length) {
      html += `<section class="jx-ask-section">
        <h4>二、出处与链接</h4>
        <ul class="jx-ask-sources">
          ${sources
            .map((s) => {
              const title = `${escapeHtml(s.moduleTitle)} · ${escapeHtml(s.lessonTitle)}`;
              return `<li><span class="jx-ask-label">${escapeHtml(s.label)}</span>：<a href="${escapeHtml(s.href)}">${title}</a></li>`;
            })
            .join('')}
        </ul>
      </section>`;
    }

    if (summary) {
      html += `<section class="jx-ask-section">
        <h4>三、归纳要点</h4>
        <div class="jx-ask-summary">${escapeHtml(summary)}</div>
      </section>`;
    }

    if (data.meta && data.meta.selection) {
      let tip = '';
      if (data.meta.selection === 'hybrid-vector') {
        tip = `检索方式：向量混合检索（段落 ${data.meta.passages || '—'} / 命中 ${data.meta.returned ?? data.sources?.length ?? '—'}）`;
      } else {
        tip = `检索方式：关键词回退`;
      }
      html += `<p class="jx-ask-meta">${escapeHtml(tip)}</p>`;
    }

    answerEl.innerHTML = html;
    answerEl.hidden = !html;
  }

  async function ask() {
    const question = String(input.value || '').trim();
    errEl.hidden = true;
    answerEl.hidden = true;
    answerEl.innerHTML = '';
    if (!question) {
      errEl.textContent = '请先输入问题';
      errEl.hidden = false;
      return;
    }

    submit.disabled = true;
    submit.textContent = '检索中…';
    const ctx = currentContext();

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          moduleSlug: ctx.moduleSlug || undefined,
          lessonSlug: ctx.lessonSlug || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
      renderAnswer(data);
    } catch (e) {
      errEl.textContent = e.message || String(e);
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '提问';
    }
  }

  submit.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ask();
    }
  });

  document.body.appendChild(panel);
  document.body.appendChild(fab);
})();
