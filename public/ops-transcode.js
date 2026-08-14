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
              <label>选择课程</label>
              <select id="tc-module-select">
                <option value="">-- 请选择模块 --</option>
              </select>
              <select id="tc-lesson-select" disabled>
                <option value="">-- 请先选择模块 --</option>
              </select>
              <p class="transcode-hint">选择已有视频的课程</p>
            </div>

            <div id="tc-video-info" class="transcode-field" hidden>
              <label>视频信息</label>
              <div id="tc-video-info-box" class="tc-video-info-box"></div>
            </div>

            <div class="transcode-field">
              <label>处理模式</label>
              <select id="tc-mode">
                <option value="transcode">仅转码（兼容苹果设备）</option>
                <option value="transcode_split" selected>转码 + 按时间点拆分</option>
                <option value="split">仅拆分（不转码）</option>
              </select>
            </div>

            <div id="tc-split-section" class="transcode-field" hidden>
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

    const topPanels = document.querySelector('.ops-top-panels');
    if (topPanels) {
      topPanels.appendChild(panel);
    } else {
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
    }

    bindEvents();
    loadModules();
  }

  function loadModules() {
    const catalog = window.__OPS_CATALOG__;
    const moduleSelect = document.getElementById('tc-module-select');
    if (!catalog || !catalog.modules || catalog.modules.length === 0) {
      moduleSelect.innerHTML = '<option value="">-- 数据未加载，请刷新页面后重试 --</option>';
      return;
    }
    // 先显示所有模块，课程筛选里再判断有没有视频
    moduleSelect.innerHTML = '<option value="">-- 请选择模块 --</option>' +
      catalog.modules
        .map(m => `<option value="${m.slug}">${m.title}</option>`)
        .join('');
  }

  function loadLessons(moduleSlug) {
    const catalog = window.__OPS_CATALOG__;
    const lessonSelect = document.getElementById('tc-lesson-select');
    const videoInfo = document.getElementById('tc-video-info');
    const videoInfoBox = document.getElementById('tc-video-info-box');

    if (!moduleSlug) {
      lessonSelect.innerHTML = '<option value="">-- 请先选择模块 --</option>';
      lessonSelect.disabled = true;
      videoInfo.hidden = true;
      return;
    }

    const mod = catalog?.modules?.find(m => m.slug === moduleSlug);
    if (!mod) {
      lessonSelect.innerHTML = '<option value="">-- 模块不存在 --</option>';
      lessonSelect.disabled = true;
      return;
    }

    const lessons = [];
    for (const ch of (mod.chapters || [])) {
      for (const les of (ch.lessons || [])) {
        if (les.videoPath) {
          lessons.push({
            slug: les.slug || '',
            title: les.title || '未命名',
            videoPath: les.videoPath,
            audioPath: les.audioPath || '',
          });
        }
      }
    }

    if (lessons.length === 0) {
      lessonSelect.innerHTML = '<option value="">-- 该模块暂无视频课程 --</option>';
      lessonSelect.disabled = true;
      videoInfo.hidden = true;
      return;
    }

    lessonSelect.innerHTML = '<option value="">-- 请选择课程 --</option>' +
      lessons.map(l => `<option value="${l.slug}">${l.title}</option>`).join('');
    lessonSelect.disabled = false;

    lessonSelect.onchange = () => {
      const sel = lessons.find(l => l.slug === lessonSelect.value);
      if (sel) {
        videoInfo.hidden = false;
        videoInfoBox.innerHTML = `
          <p>课程标题：<strong>${sel.title}</strong></p>
          <p>视频路径：<code>${sel.videoPath}</code></p>
        `;
      } else {
        videoInfo.hidden = true;
      }
    };
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
      if (!expanded) {
        loadJobs();
        loadModules(); // 展开时重新加载模块列表
      }
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

    document.getElementById('tc-module-select')?.addEventListener('change', (e) => {
      loadLessons(e.target.value);
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
      splitSection.hidden = !mode.includes('split');
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

    const moduleSlug = document.getElementById('tc-module-select').value;
    const lessonSlug = document.getElementById('tc-lesson-select').value;

    if (!moduleSlug || !lessonSlug) {
      showMsg(msg, '请先选择模块和课程', 'error');
      return;
    }

    const catalog = window.__OPS_CATALOG__;
    const mod = catalog?.modules?.find(m => m.slug === moduleSlug);
    if (!mod) {
      showMsg(msg, '模块不存在', 'error');
      return;
    }

    let lesson = null;
    for (const ch of (mod.chapters || [])) {
      for (const les of (ch.lessons || [])) {
        if (les.slug === lessonSlug) {
          lesson = les;
          break;
        }
      }
      if (lesson) break;
    }

    if (!lesson || !lesson.videoPath) {
      showMsg(msg, '该课程没有视频', 'error');
      return;
    }

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

    const r2Base = document.querySelector('meta[name="r2-base"]')?.content || '';
    const sourceUrl = lesson.videoPath;
    const fullUrl = /^https?:\/\//.test(sourceUrl) ? sourceUrl : `${r2Base}/${sourceUrl.replace(/^\//, '')}`;
    const outputPath = sourceUrl.replace(/\.[^.]+$/, '');

    const data = {
      source_url: fullUrl,
      output_path: outputPath,
      mode,
      module_slug: moduleSlug,
      lesson_slug: lessonSlug,
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
      // 504 是因为转码时间太长 Nginx 超时，任务还在后台跑
      if (String(err.message || '').includes('504')) {
        container.innerHTML = `<p class="transcode-empty" style="color:#e67e22;">任务处理中（转码耗时较长，预计 10-30 分钟），请稍后刷新或查看服务器日志</p>`;
      } else {
        container.innerHTML = `<p class="transcode-empty" style="color:#c00;">加载失败：${err.message}</p>`;
      }
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
    
    const progress = Math.round(job.progress || 0);
    const statusText = statusMap[job.status] || job.status;
    let timeHint = '';
    if (job.status === 'transcoding' && progress > 0 && progress < 100) {
      const remaining = Math.ceil((100 - progress) / 2);
      timeHint = ` · 预计剩余 ${remaining} 分钟`;
    } else if (job.status === 'downloading') {
      timeHint = ' · 下载中，请稍候';
    } else if (job.status === 'processing' && progress < 100) {
      timeHint = ' · 处理中，请稍候';
    } else if (job.status === 'splitting') {
      timeHint = ' · 拆分中，请稍候';
    }

    const jobId = job.id || job.job_id || '';
    const msg = job.message ? ` · ${job.message}` : '';

    return `
      <div class="tc-job tc-job--${statusClass}">
        <div class="tc-job-head">
          <span class="tc-job-status">${statusText}</span>
          <span class="tc-job-progress">${progress}%${timeHint}</span>
          <button type="button" class="tc-job-del btn ops-mini" data-job="${jobId}" style="color:#c00;border-color:#c00;">删除</button>
        </div>
        <div class="tc-job-body">
          <p class="tc-job-path">任务ID：${jobId}</p>
          ${msg ? `<p class="tc-job-path">${msg}</p>` : ''}
          ${job.error ? `<p class="tc-job-error">错误：${job.error}</p>` : ''}
        </div>
        <div class="tc-job-bar">
          <div class="tc-job-bar-fill" style="width:${progress}%"></div>
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
    askTranscode,
    askBeforeUpload,
    submitTask,
  };

  let pendingTranscodeConfig = null;

  function askBeforeUpload(videoPath, mod, les, file) {
    return new Promise((resolve) => {
      const r2Base = document.querySelector('meta[name="r2-base"]')?.content || '';
      const fullUrl = videoPath.startsWith('http') ? videoPath : `${r2Base}/${videoPath.replace(/^\//, '')}`;
      const outputPath = videoPath.replace(/\.[^.]+$/, '');
      const fileSizeMb = (file.size / 1024 / 1024).toFixed(1);
      const fileName = file.name;

      const modal = document.createElement('div');
      modal.className = 'tc-modal';
      modal.innerHTML = `
        <div class="tc-modal-bg"></div>
        <div class="tc-modal-box">
          <div class="tc-modal-head">
            <h3>视频上传处理配置</h3>
            <button class="tc-modal-close" type="button">×</button>
          </div>
          <div class="tc-modal-body">
            <div class="tc-info">
              <p>文件名：<code>${fileName}</code></p>
              <p>大小：<code>${fileSizeMb} MB</code></p>
              <p>输出路径：<code>${videoPath}</code></p>
            </div>

            <div class="tc-warn" style="background:#fff8e1;padding:0.8rem 1rem;border-radius:6px;border:1px solid #ffe58f;font-size:0.88rem;">
              💡 选择后开始上传，上传完毕自动提交服务端处理，<strong>无需等待</strong>，可关闭页面离开。
            </div>
            
            <div class="tc-option">
              <label class="tc-option-item">
                <input type="radio" name="tc-mode" value="skip" checked />
                <span>不用了，直接上传原视频</span>
              </label>
              <label class="tc-option-item">
                <input type="radio" name="tc-mode" value="transcode" />
                <span>仅转码（H.264+AAC，iOS/苹果兼容）</span>
              </label>
              <label class="tc-option-item">
                <input type="radio" name="tc-mode" value="transcode_split" />
                <span>转码 + 按时间点拆分（推荐）</span>
              </label>
              <label class="tc-option-item">
                <input type="radio" name="tc-mode" value="split" />
                <span>仅拆分（不改编码）</span>
              </label>
            </div>

            <div id="tc-split-config" class="tc-split-config" hidden>
              <p class="tc-split-hint">输入拆分时间点（HH:MM:SS）和章节标题</p>
              <div id="tc-split-list" class="tc-split-list"></div>
              <div class="tc-split-actions">
                <button type="button" class="btn ops-mini" id="tc-add-split" style="color:inherit;border-color:var(--line);">+ 添加时间点</button>
                <button type="button" class="btn ops-mini" id="tc-auto-split" style="color:inherit;border-color:var(--line);">每 1 小时自动拆分</button>
              </div>
            </div>
          </div>
          <div class="tc-modal-foot">
            <button class="btn btn--solid" id="tc-confirm" style="color:#fbf6e6;">确认并开始上传</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const closeBtn = modal.querySelector('.tc-modal-close');
      const confirmBtn = modal.querySelector('#tc-confirm');
      const splitConfig = modal.querySelector('#tc-split-config');
      const modeRadios = modal.querySelectorAll('input[name="tc-mode"]');

      function closeWith(result) {
        modal.remove();
        resolve(result);
      }

      closeBtn.addEventListener('click', () => closeWith({ skip: true }));

      modeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
          const mode = radio.value;
          splitConfig.hidden = !mode.includes('split');
        });
      });

      const splitList = modal.querySelector('#tc-split-list');
      const addSplitBtn = modal.querySelector('#tc-add-split');
      const autoSplitBtn = modal.querySelector('#tc-auto-split');

      function addSplitRow(time = '', title = '') {
        const row = document.createElement('div');
        row.className = 'tc-split-row';
        row.innerHTML = `
          <input type="text" class="tc-sp-time" placeholder="时间 HH:MM:SS" value="${time}" />
          <input type="text" class="tc-sp-title" placeholder="章节标题" value="${title}" />
          <button type="button" class="tc-sp-del btn ops-mini" style="color:#c00;border-color:#c00;">×</button>
        `;
        row.querySelector('.tc-sp-del').addEventListener('click', () => row.remove());
        splitList.appendChild(row);
      }

      addSplitBtn.addEventListener('click', () => addSplitRow());
      autoSplitBtn.addEventListener('click', () => {
        splitList.innerHTML = '';
        for (let h = 1; h <= 10; h++) {
          addSplitRow(`${h}:00:00`, `第${h + 1}课`);
        }
      });

      confirmBtn.addEventListener('click', () => {
        const mode = modal.querySelector('input[name="tc-mode"]:checked').value;
        
        if (mode === 'skip') {
          closeWith({ skip: true });
          return;
        }

        let splitPoints = null;
        if (mode.includes('split')) {
          const rows = splitList.querySelectorAll('.tc-split-row');
          splitPoints = [];
          for (const row of rows) {
            // 清洗时间格式：去空格、中文冒号转英文
            let time = row.querySelector('.tc-sp-time').value
              .trim()
              .replace(/[\s　]+/g, '')
              .replace(/：/g, ':');
            const title = row.querySelector('.tc-sp-title').value.trim();
            if (time && title) {
              splitPoints.push({ time, title });
            }
          }
          if (splitPoints.length === 0) {
            alert('请至少添加一个拆分时间点');
            return;
          }
        }

        const config = {
          source_url: fullUrl,
          output_path: outputPath,
          mode,
          module_slug: mod.slug,
          lesson_slug: les.slug,
          split_points: splitPoints,
          skip: false,
        };

        pendingTranscodeConfig = config;
        closeWith(config);
      });
    });
  }

  async function submitTask(config) {
    if (!config || config.skip) return;

    const body = {
      source_url: config.source_url,
      output_path: config.output_path,
      mode: config.mode,
      module_slug: config.module_slug,
      lesson_slug: config.lesson_slug,
      split_points: config.split_points,
    };

    const res = await fetch(`${API_PREFIX}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function askTranscode(videoPath, mod, les) {
    const r2Base = document.querySelector('meta[name="r2-base"]')?.content || '';
    const fullUrl = videoPath.startsWith('http') ? videoPath : `${r2Base}/${videoPath.replace(/^\//, '')}`;
    const outputPath = videoPath.replace(/\.[^.]+$/, '');

    const modal = document.createElement('div');
    modal.className = 'tc-modal';
    modal.innerHTML = `
      <div class="tc-modal-bg"></div>
      <div class="tc-modal-box">
        <div class="tc-modal-head">
          <h3>上传完成！是否需要服务端自动转码/拆分？</h3>
          <button class="tc-modal-close" type="button">×</button>
        </div>
        <div class="tc-modal-body">
          <div class="tc-info">
            <p>视频路径：<code>${videoPath}</code></p>
            <p>模块：<code>${mod.slug}</code> · 课程：<code>${les.slug}</code></p>
          </div>
          
          <div class="tc-option">
            <label class="tc-option-item">
              <input type="radio" name="tc-mode" value="skip" checked />
              <span>不需要，直接使用原视频</span>
            </label>
            <label class="tc-option-item">
              <input type="radio" name="tc-mode" value="transcode" />
              <span>仅转码（H.264+AAC，苹果兼容）</span>
            </label>
            <label class="tc-option-item">
              <input type="radio" name="tc-mode" value="transcode_split" />
              <span>转码 + 拆分（推荐）</span>
            </label>
            <label class="tc-option-item">
              <input type="radio" name="tc-mode" value="split" />
              <span>仅拆分（不改编码）</span>
            </label>
          </div>

          <div id="tc-split-config" class="tc-split-config" hidden>
            <p class="tc-split-hint">输入拆分时间点（HH:MM:SS）和章节标题，留空则不拆分</p>
            <div id="tc-split-list" class="tc-split-list"></div>
            <div class="tc-split-actions">
              <button type="button" class="btn ops-mini" id="tc-add-split" style="color:inherit;border-color:var(--line);">+ 添加时间点</button>
              <button type="button" class="btn ops-mini" id="tc-auto-split" style="color:inherit;border-color:var(--line);">每 1 小时自动拆分</button>
            </div>
          </div>
        </div>
        <div class="tc-modal-foot">
          <button class="btn ops-mini" id="tc-cancel" style="color:inherit;border-color:var(--line);">跳过</button>
          <button class="btn btn--solid" id="tc-submit" style="color:#fbf6e6;">提交任务</button>
        </div>
        <div id="tc-modal-msg" class="tc-modal-msg" hidden></div>
      </div>
    `;
    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.tc-modal-close');
    const cancelBtn = modal.querySelector('#tc-cancel');
    const submitBtn = modal.querySelector('#tc-submit');
    const msg = modal.querySelector('#tc-modal-msg');
    const splitConfig = modal.querySelector('#tc-split-config');
    const modeRadios = modal.querySelectorAll('input[name="tc-mode"]');

    function close() {
      modal.remove();
    }

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);

    modeRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        const mode = radio.value;
        splitConfig.hidden = !mode.includes('split');
      });
    });

    const splitList = modal.querySelector('#tc-split-list');
    const addSplitBtn = modal.querySelector('#tc-add-split');
    const autoSplitBtn = modal.querySelector('#tc-auto-split');

    function addSplitRow(time = '', title = '') {
      const row = document.createElement('div');
      row.className = 'tc-split-row';
      row.innerHTML = `
        <input type="text" class="tc-sp-time" placeholder="时间 HH:MM:SS" value="${time}" />
        <input type="text" class="tc-sp-title" placeholder="章节标题" value="${title}" />
        <button type="button" class="tc-sp-del btn ops-mini" style="color:#c00;border-color:#c00;">×</button>
      `;
      row.querySelector('.tc-sp-del').addEventListener('click', () => row.remove());
      splitList.appendChild(row);
    }

    addSplitBtn.addEventListener('click', () => addSplitRow());
    autoSplitBtn.addEventListener('click', () => {
      splitList.innerHTML = '';
      for (let h = 1; h <= 10; h++) {
        addSplitRow(`${h}:00:00`, `第${h + 1}课`);
      }
    });

    submitBtn.addEventListener('click', async () => {
      const mode = modal.querySelector('input[name="tc-mode"]:checked').value;
      
      if (mode === 'skip') {
        close();
        return;
      }

      let splitPoints = null;
      if (mode.includes('split')) {
        const rows = splitList.querySelectorAll('.tc-split-row');
        splitPoints = [];
        for (const row of rows) {
          const time = row.querySelector('.tc-sp-time').value.trim();
          const title = row.querySelector('.tc-sp-title').value.trim();
          if (time && title) {
            splitPoints.push({ time, title });
          }
        }
        if (splitPoints.length === 0) {
          showModalMsg(msg, '请至少添加一个拆分时间点', 'error');
          return;
        }
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';

      try {
        const body = {
          source_url: fullUrl,
          output_path: outputPath,
          mode,
          module_slug: mod.slug,
          lesson_slug: les.slug,
          split_points: splitPoints,
        };

        const res = await fetch(`${API_PREFIX}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();
        
        showModalMsg(msg, `✅ 任务已提交：${result.job_id}，可在"任务列表"查看进度`, 'success');
        
        setTimeout(() => {
          close();
          loadJobs();
        }, 2000);
      } catch (err) {
        showModalMsg(msg, `❌ 提交失败：${err.message}`, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '重试';
      }
    });

    function showModalMsg(el, text, type) {
      el.hidden = false;
      el.textContent = text;
      el.style.color = type === 'error' ? '#c00' : '#080';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }
})();
