/**
 * 运营后台：视频转码/拆分面板
 * 通过阿里云服务端实现自动转码和拆分
 */
(() => {
  const API_PREFIX = '/api/transcode';
  let currentJobs = [];
  let pollingTimer = null;

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'transcode-panel';
    panel.className = 'ops-cards-panel ops-cards-panel--collapsible';
    panel.innerHTML = `
      <button type="button" class="ops-cards-toggle" id="btn-transcode-toggle" aria-expanded="false">
        <strong>视频转码 / 拆分</strong>
        <span id="transcode-summary" class="ops-cards-summary">未加载</span>
        <span class="ops-cards-toggle__hint">展开</span>
      </button>
      <div class="ops-cards-body" id="transcode-body" hidden>
        <div class="transcode-tabs" role="tablist">
          <button type="button" class="transcode-tab is-active" data-tab="create">创建任务</button>
          <button type="button" class="transcode-tab" data-tab="list">任务列表</button>
        </div>

        <div id="transcode-create" class="transcode-content">
          <form id="transcode-form" class="transcode-form">
            <div class="transcode-field">
              <label>原视频 URL（R2 路径）</label>
              <input type="text" id="tc-source-url" required placeholder="https://media.huidengjingtu.win/module/video.mp4" />
              <p class="transcode-hint">完整 URL 或 R2 相对路径均可</p>
            </div>

            <div class="transcode-field">
              <label>输出路径（R2）</label>
              <input type="text" id="tc-output-path" required placeholder="nianfo/xuexiu-yindao" />
              <p class="transcode-hint">不含扩展名，自动生成 .mp4</p>
            </div>

            <div class="transcode-row">
              <div class="transcode-field">
                <label>模块 Slug</label>
                <input type="text" id="tc-module-slug" placeholder="nianfo" />
              </div>
              <div class="transcode-field">
                <label>课程 Slug</label>
                <input type="text" id="tc-lesson-slug" placeholder="xuexiu-yindao" />
              </div>
            </div>

            <div class="transcode-field">
              <label>处理模式</label>
              <select id="tc-mode">
                <option value="transcode">仅转码（H.264 + AAC + faststart）</option>
                <option value="transcode_split" selected>转码 + 按时间点拆分</option>
                <option value="split">仅拆分（不转码）</option>
              </select>
            </div>

            <div id="tc-split-section" class="transcode-field">
              <label>拆分时间点</label>
              <div id="tc-split-points" class="transcode-split-points"></div>
              <div class="transcode-split-actions">
                <button type="button" id="tc-add-split" class="btn ops-mini" style="color:inherit;border-color:var(--line);">+ 添加时间点</button>
                <button type="button" id="tc-auto-split" class="btn ops-mini" style="color:inherit;border-color:var(--line);">按 1 小时自动拆分</button>
              </div>
              <p class="transcode-hint">格式：HH:MM:SS，例如 00:51:49</p>
            </div>

            <button type="submit" class="btn btn--solid" style="color:#fbf6e6;width:100%;margin-top:1rem;">
              提交转码任务
            </button>
            <p id="tc-form-msg" class="ops-msg" hidden></p>
          </form>
        </div>

        <div id="transcode-list" class="transcode-content" hidden>
          <div class="transcode-list-actions">
            <button type="button" id="tc-refresh" class="btn ops-mini" style="color:inherit;border-color:var(--line);">刷新</button>
            <label class="tc-auto-refresh">
              <input type="checkbox" id="tc-auto-poll" />
              自动刷新（3秒）
            </label>
          </div>
          <div id="tc-jobs" class="transcode-jobs">
            <p class="transcode-empty">加载中...</p>
          </div>
        </div>
      </div>
    `;

    const feedbackPanel = document.getElementById('feedback-panel');
    if (feedbackPanel && feedbackPanel.parentNode) {
      feedbackPanel.parentNode.insertBefore(panel, feedbackPanel.nextSibling);
    } else {
      const opsGrid = document.getElementById('ops-grid');
      if (opsGrid) {
        opsGrid.parentNode.insertBefore(panel, opsGrid);
      } else {
        document.querySelector('.section .wrap')?.appendChild(panel);
      }
    }

    bindEvents();
    addSplitPoint('51:49', '第二课');
    addSplitPoint('1:34:15', '第三课');
    addSplitPoint('2:14:11', '第四课');
  }

  function bindEvents() {
    const toggle = document.getElementById('btn-transcode-toggle');
    const body = document.getElementById('transcode-body');
    const hint = toggle?.querySelector('.ops-cards-toggle__hint');
    toggle?.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      body.hidden = expanded;
      if (hint) hint.textContent = expanded ? '展开' : '收起';
      if (!expanded) loadJobs();
    });

    document.querySelectorAll('.transcode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.transcode-tab').forEach(t => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        const target = tab.dataset.tab;
        document.getElementById('transcode-create').hidden = target !== 'create';
        document.getElementById('transcode-list').hidden = target !== 'list';
        if (target === 'list') loadJobs();
      });
    });

    document.getElementById('tc-add-split')?.addEventListener('click', () => {
      addSplitPoint('', '');
    });

    document.getElementById('tc-auto-split')?.addEventListener('click', () => {
      const container = document.getElementById('tc-split-points');
      container.innerHTML = '';
      for (let h = 1; h <= 10; h++) {
        addSplitPoint(`${h}:00:00`, `第${h + 1}课`);
      }
    });

    document.getElementById('tc-mode')?.addEventListener('change', (e) => {
      const mode = e.target.value;
      const splitSection = document.getElementById('tc-split-section');
      splitSection.style.display = mode.includes('split') ? '' : 'none';
    });

    document.getElementById('transcode-form')?.addEventListener('submit', handleSubmit);
    document.getElementById('tc-refresh')?.addEventListener('click', loadJobs);
    document.getElementById('tc-auto-poll')?.addEventListener('change', (e) => {
      if (e.target.checked) {
        pollingTimer = setInterval(loadJobs, 3000);
      } else {
        clearInterval(pollingTimer);
      }
    });
  }

  function addSplitPoint(time = '', title = '') {
    const container = document.getElementById('tc-split-points');
    const div = document.createElement('div');
    div.className = 'transcode-split-point';
    div.innerHTML = `
      <input type="text" class="tc-sp-time" placeholder="时间 HH:MM:SS" value="${time}" />
      <input type="text" class="tc-sp-title" placeholder="标题" value="${title}" />
      <button type="button" class="tc-sp-del btn ops-mini" style="color:#c00;border-color:#c00;">×</button>
    `;
    div.querySelector('.tc-sp-del').addEventListener('click', () => div.remove());
    container.appendChild(div);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const msg = document.getElementById('tc-form-msg');
    msg.hidden = true;

    const mode = document.getElementById('tc-mode').value;
    const splitPoints = [];

    if (mode.includes('split')) {
      document.querySelectorAll('.transcode-split-point').forEach(sp => {
        const time = sp.querySelector('.tc-sp-time').value.trim();
        const title = sp.querySelector('.tc-sp-title').value.trim();
        if (time && title) {
          splitPoints.push({ time, title });
        }
      });

      if (splitPoints.length === 0) {
        showMsg(msg, '请至少添加一个拆分时间点', 'error');
        return;
      }
    }

    const sourceUrl = document.getElementById('tc-source-url').value.trim();
    let fullUrl = sourceUrl;
    if (!/^https?:\/\//.test(sourceUrl)) {
      const r2Base = document.querySelector('meta[name="r2-base"]')?.content || '';
      fullUrl = `${r2Base}/${sourceUrl.replace(/^\//, '')}`;
    }

    const data = {
      source_url: fullUrl,
      output_path: document.getElementById('tc-output-path').value.trim(),
      mode,
      module_slug: document.getElementById('tc-module-slug').value.trim() || null,
      lesson_slug: document.getElementById('tc-lesson-slug').value.trim() || null,
      split_points: splitPoints.length > 0 ? splitPoints : null,
    };

    try {
      showMsg(msg, '正在提交任务...', 'info');
      const res = await fetch(`${API_PREFIX}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      showMsg(msg, `任务已创建：${result.job_id}`, 'success');

      setTimeout(() => {
        document.querySelector('.transcode-tab[data-tab="list"]').click();
      }, 1000);
    } catch (err) {
      showMsg(msg, `提交失败：${err.message}`, 'error');
    }
  }

  function showMsg(el, text, type = 'info') {
    el.hidden = false;
    el.textContent = text;
    el.style.color = type === 'error' ? '#c00' : type === 'success' ? '#080' : '';
  }

  async function loadJobs() {
    const container = document.getElementById('tc-jobs');
    container.innerHTML = '<p class="transcode-empty">加载中...</p>';

    try {
      const res = await fetch(`${API_PREFIX}/jobs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentJobs = data.jobs || [];

      const summary = document.getElementById('transcode-summary');
      const pending = currentJobs.filter(j => ['pending', 'downloading', 'processing', 'transcoding', 'uploading'].includes(j.status)).length;
      const completed = currentJobs.filter(j => j.status === 'completed').length;
      const failed = currentJobs.filter(j => j.status === 'failed').length;
      summary.textContent = `${data.total} 个任务 · ${pending} 进行中 · ${completed} 完成 · ${failed} 失败`;

      if (currentJobs.length === 0) {
        container.innerHTML = '<p class="transcode-empty">暂无任务</p>';
        return;
      }

      container.innerHTML = currentJobs.map(job => jobCard(job)).join('');
      bindJobActions();
    } catch (err) {
      container.innerHTML = `<p class="transcode-empty" style="color:#c00;">加载失败：${err.message}</p>`;
    }
  }

  function jobCard(job) {
    const statusMap = {
      pending: '等待中',
      downloading: '下载中',
      processing: '处理中',
      transcoding: '转码中',
      splitting: '拆分中',
      uploading: '上传中',
      completed: '已完成',
      failed: '失败',
    };
    const statusClass = job.status === 'completed' ? 'is-ok' : job.status === 'failed' ? 'is-error' : 'is-running';

    return `
      <div class="tc-job tc-job--${statusClass}">
        <div class="tc-job-head">
          <span class="tc-job-status">${statusMap[job.status] || job.status}</span>
          <span class="tc-job-progress">${Math.round(job.progress || 0)}%</span>
          <button type="button" class="tc-job-del btn ops-mini" data-job="${job.job_id}" style="color:#c00;border-color:#c00;">删除</button>
        </div>
        <div class="tc-job-body">
          <p class="tc-job-path">输入：${job.source_url?.split('/').pop() || job.source_url}</p>
          <p class="tc-job-path">输出：${job.output_path}</p>
          <p class="tc-job-mode">模式：${job.mode} · ${job.message || ''}</p>
          ${job.segments ? `
            <div class="tc-job-segments">
              <strong>输出片段：</strong>
              ${JSON.parse(job.segments)?.map(s => `
                <span class="tc-segment">${s.title || s.index}: ${s.path} (${(s.size_mb || 0).toFixed(1)}MB)</span>
              `).join('') || ''}
            </div>
          ` : ''}
          ${job.error ? `<p class="tc-job-error">错误：${job.error}</p>` : ''}
        </div>
        <div class="tc-job-bar">
          <div class="tc-job-bar-fill" style="width:${job.progress || 0}%"></div>
        </div>
      </div>
    `;
  }

  function bindJobActions() {
    document.querySelectorAll('.tc-job-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const jobId = btn.dataset.job;
        if (!confirm(`确认删除任务 ${jobId}？`)) return;
        try {
          await fetch(`${API_PREFIX}/jobs/${jobId}`, { method: 'DELETE' });
          loadJobs();
        } catch (err) {
          alert('删除失败：' + err.message);
        }
      });
    });
  }

  window.JXTranscode = {
    init: createPanel,
    refresh: loadJobs,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }
})();
