(() => {
  const $ = (id) => document.getElementById(id);
  const loginBox = $('ops-login');
  const appBox = $('ops-app');
  const moduleList = $('module-list');
  const editor = $('module-editor');
  const saveMsg = $('save-msg');
  const dirtyBanner = $('dirty-banner');

  let catalog = null;
  /** 公众号好文（独立于学修课表） */
  let articleCollections = [];
  let articlesRev = 0;
  let moduleIndex = 0;
  /** @type {'module' | 'refs' | 'articles'} */
  let sideMode = 'module';
  /** @type {'structure' | 'lesson'} */
  let view = 'structure';
  /** @type {{ ci: number, li: number } | null} */
  let editPath = null;
  /** 参考书籍：null=列表，数字=正在编辑该项 */
  let refsEditIndex = null;
  /** 公众号好文集合：null=列表，数字=正在编辑该集合 */
  let acolEditIndex = null;
  let dirty = false;
  let articlesDirty = false;
  let saving = false;
  /** 展开中的章节 id（默认全部折叠） */
  const expandedChapterIds = new Set();
  /** 学修侧栏：折叠中的分区标题 */
  const collapsedNavGroups = new Set();
  let navFilterReady = false;
  let modSearch = '';
  let modStatusFilter = 'all';

  /** 与前台学修分区一致 */
  const OPS_SECTIONS = [
    { title: '净土学修', slugs: ['nianfo', 'jingdian', 'xiuxing'] },
  ];

  const OPS_SECTION_TITLES = OPS_SECTIONS.map((s) => s.title);
  const OPS_PRO_GROUPS = [];

  function legacyPlacementMap() {
    const map = Object.create(null);
    for (const sec of OPS_SECTIONS) {
      for (const slug of sec.slugs || []) map[slug] = { section: sec.title, group: '' };
      for (const g of sec.groups || []) {
        for (const slug of g.slugs || []) map[slug] = { section: sec.title, group: g.title || '' };
      }
    }
    return map;
  }

  function resolveOpsModSection(mod) {
    if (!mod) return { section: '', group: '' };
    if (mod.section === '未归类') return { section: '', group: '' };
    const sec = String(mod.section ?? '').trim();
    if (sec) return { section: sec, group: String(mod.sectionGroup || '').trim() };
    const legacy = legacyPlacementMap()[mod.slug];
    if (legacy) return { section: legacy.section, group: legacy.group || '' };
    return { section: '', group: '' };
  }

  function backfillModuleSections() {
    const map = legacyPlacementMap();
    for (const mod of catalog?.modules || []) {
      if (mod.section != null && String(mod.section).trim() !== '') continue;
      const legacy = map[mod.slug];
      if (legacy) {
        mod.section = legacy.section;
        mod.sectionGroup = legacy.group || '';
      }
    }
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function autoSlug(title, fallback) {
    const base = String(title || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!base || /[\u4e00-\u9fff]/.test(base)) {
      return fallback || `lesson-${uid('l')}`;
    }
    return base.slice(0, 48) || fallback || `lesson-${uid('l')}`;
  }

  /** 模块网址标识：仅小写字母、数字、连字符 */
  function normalizeModSlug(raw, fallback) {
    let s = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
    if (!s || !/^[a-z][a-z0-9-]*$/.test(s)) return fallback || `mod-${uid('m')}`;
    return s;
  }

  function uniqueModSlug(slug, exceptIndex) {
    let base = slug;
    let n = 2;
    let next = slug;
    while (catalog.modules.some((m, i) => i !== exceptIndex && m.slug === next)) {
      next = `${base}-${n++}`;
    }
    return next;
  }

  function statusLabelFor(status) {
    return status === 'open' ? '开放中' : '即将开放';
  }

  function addModule() {
    const n = (catalog.modules?.length || 0) + 1;
    const title = `新模块 ${n}`;
    // 网址标识自动生成，运营无需填写；一旦生成不随标题改动，以免音视频路径错乱
    const slug = uniqueModSlug(`mod-${uid('m')}`, -1);
    catalog.modules.push({
      id: slug,
      slug,
      title,
      shortTitle: title,
      summary: '',
      status: 'coming',
      statusLabel: statusLabelFor('coming'),
      intro: '',
      references: [],
      chapters: [],
    });
    moduleIndex = catalog.modules.length - 1;
    sideMode = 'module';
    view = 'structure';
    editPath = null;
    setDirty(true);
    collapsedNavGroups.delete('其他');
    renderModuleList();
    renderEditor();
    showMsg(saveMsg, '已添加模块。可在「学修分区」下拉中选择归属；未选则出现在前台「未归类」。', true);
  }

  function assetUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//.test(path)) return path;
    const base =
      document.querySelector('meta[name="r2-base"]')?.content?.replace(/\/$/, '') || '';
    if (!base) return '';
    return `${base}/${path.replace(/^\//, '')}`;
  }

  function showMsg(el, text, ok) {
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('is-ok', !!ok);
    el.classList.toggle('is-error', !ok);
  }

  function anyDirty() {
    return dirty || articlesDirty;
  }

  function refreshDirtyBanner() {
    if (!dirtyBanner) return;
    if (sideMode === 'articles') {
      dirtyBanner.hidden = !articlesDirty;
      dirtyBanner.textContent = '公众号好文有未保存修改，请点「保存好文」（与学修课表分开保存）。';
      return;
    }
    dirtyBanner.hidden = !dirty;
    dirtyBanner.textContent =
      '有未保存的修改，请点「保存到服务器」。上传成功会自动保存。多人同时编辑时若冲突会提示重新加载；保存前自动备份上一版。';
  }

  function setDirty(value) {
    dirty = !!value;
    refreshDirtyBanner();
  }

  function setArticlesDirty(value) {
    articlesDirty = !!value;
    refreshDirtyBanner();
  }

  async function api(url, options = {}) {
    let res;
    try {
      res = await fetch(url, { credentials: 'same-origin', ...options });
    } catch (e) {
      const err = new Error(`网络请求失败 (${url}): ${e.message}`);
      err.code = 'NETWORK';
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `请求失败 ${res.status}`);
      err.code = data.code;
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const MULTIPART_THRESHOLD = 20 * 1024 * 1024;
  const PART_SIZE = 8 * 1024 * 1024;

  function mediaExt(file, fallback) {
    const name = String(file?.name || '');
    if (name.includes('.')) {
      const ext = name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (ext) return ext;
    }
    return fallback;
  }

  /** 每次上传用新 key，长缓存才不会命中旧文件 */
  function versionedKey(dirAndStem, ext) {
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const stem = String(dirAndStem || 'file').replace(/\/+$/, '');
    return `${stem}-${stamp}.${ext}`;
  }

  function mimeForUpload(key, file) {
    const name = String(key || file?.name || '').toLowerCase();
    if (name.endsWith('.mp4') || name.endsWith('.m4v')) return 'video/mp4';
    if (name.endsWith('.webm')) return 'video/webm';
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    if (name.endsWith('.m4a')) return 'audio/mp4';
    if (name.endsWith('.pdf')) return 'application/pdf';
    return file?.type || 'application/octet-stream';
  }

  async function uploadFile(key, file, onProgress) {
    if (file.size <= MULTIPART_THRESHOLD) {
      const fd = new FormData();
      fd.set('key', key);
      fd.set('file', file);
      if (onProgress) onProgress(0, file.size);
      const result = await api('/api/upload', { method: 'POST', body: fd });
      if (onProgress) onProgress(file.size, file.size);
      return result;
    }

    const init = await api('/api/upload-init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        contentType: mimeForUpload(key, file),
      }),
    });

    const parts = [];
    const total = file.size;
    let offset = 0;
    let partNumber = 1;

    while (offset < total) {
      const end = Math.min(offset + PART_SIZE, total);
      const blob = file.slice(offset, end);
      const qs = new URLSearchParams({
        key,
        uploadId: init.uploadId,
        partNumber: String(partNumber),
      });
      const res = await fetch(`/api/upload-part?${qs}`, {
        method: 'PUT',
        credentials: 'same-origin',
        body: blob,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `分片 ${partNumber} 失败`);
      parts.push({ partNumber: data.partNumber, etag: data.etag });
      offset = end;
      partNumber += 1;
      if (onProgress) onProgress(offset, total);
    }

    return api('/api/upload-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, uploadId: init.uploadId, parts }),
    });
  }

  async function saveCatalog(opts = {}) {
    const { silent = false, reason = '', force = false, _autoRetryCount = 0 } = opts;
    const autoRetryCount = _autoRetryCount;
    if (saving) return;
    saving = true;
    try {
      if (!silent) showMsg(saveMsg, '保存中…', true);
      catalog.version = 4;
      if (!Array.isArray(catalog.references)) catalog.references = [];
      // 公众号好文单独存 /api/articles，不写入课表
      delete catalog.articleCollections;
      const payload = {
        ...catalog,
        version: 4,
        baseRev: catalog.rev ?? 0,
        force: !!force,
      };
      let bodyStr;
      try {
        bodyStr = JSON.stringify(payload);
      } catch (e) {
        showMsg(saveMsg, '序列化失败：' + e.message, false);
        throw e;
      }
      const result = await api('/api/catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
      });
      if (result?.rev != null) catalog.rev = result.rev;
      setDirty(false);
      const backupHint = result?.backedUp ? '（已自动备份上一版）' : '';
      const msg = (reason || '已保存。前台刷新即可看到变化。') + backupHint;
      showMsg(saveMsg, msg, true);
      refreshPassagesStatus().catch(() => {});
    } catch (e) {
      if (e.code === 'CONFLICT') {
        showMsg(saveMsg, e.message || '目录冲突', false);
        if (
          confirm(
            `${e.message || '目录已被他人更新。'}\n\n将自动重新加载服务器最新版本并重试保存（${autoRetryCount + 1}/3）。`,
          )
        ) {
          await loadCatalog();
          if (autoRetryCount < 3) {
            showMsg(saveMsg, `已重新加载，正在自动重试保存...`, false);
            return saveCatalog({ ...opts, _autoRetryCount: autoRetryCount + 1 });
          }
          showMsg(saveMsg, '自动重试次数已达上限，请手动保存', false);
          return;
        }
        showMsg(saveMsg, '已取消保存', false);
        return;
      }
      if (e.code === 'NEED_CONFIRM' && !force) {
        const ok = confirm(
          `${e.message || '课次明显减少。'}\n\n确定仍要覆盖保存吗？\n（保存前服务器会自动备份上一版）`,
        );
        if (ok) {
          saving = false;
          return saveCatalog({ ...opts, force: true });
        }
        showMsg(saveMsg, '已取消保存', false);
        return;
      }
      showMsg(saveMsg, '保存失败：' + (e.message || String(e)), false);
      throw e;
    } finally {
      saving = false;
    }
  }

  async function ensureSession() {
    try {
      await api('/api/session');
      loginBox.hidden = true;
      appBox.hidden = false;
      await Promise.all([loadCatalog(), loadArticles()]);
    } catch {
      loginBox.hidden = false;
      appBox.hidden = true;
    }
  }

  async function loadArticles() {
    const data = await api('/api/articles');
    articleCollections = Array.isArray(data.collections) ? data.collections : [];
    articlesRev = Number(data.rev) || 0;
    setArticlesDirty(false);
    if (sideMode === 'articles') renderArticleCollectionsView();
  }

  async function saveArticles(opts = {}) {
    const { reason = '' } = opts;
    if (saving) return;
    saving = true;
    try {
      showMsg(saveMsg, '正在保存公众号好文…', true);
      const result = await api('/api/articles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collections: articleCollections,
          baseRev: articlesRev,
        }),
      });
      if (result?.rev != null) articlesRev = result.rev;
      setArticlesDirty(false);
      showMsg(saveMsg, reason || '公众号好文已保存。前台刷新即可看到。', true);
    } catch (e) {
      if (e.code === 'CONFLICT') {
        showMsg(saveMsg, e.message || '好文冲突', false);
        if (confirm(`${e.message || '好文已被他人更新。'}\n\n是否重新加载？`)) {
          await loadArticles();
        }
        throw e;
      }
      showMsg(saveMsg, e.message || String(e), false);
      throw e;
    } finally {
      saving = false;
    }
  }

  async function loadCatalog() {
    catalog = await api('/api/catalog');
    if (!catalog.modules) catalog.modules = [];
    if (!Array.isArray(catalog.references)) catalog.references = [];
    delete catalog.articleCollections;
    if (catalog.rev == null) catalog.rev = 0;
    // 兼容：把仍挂在模块下的参考资料提到顶层（与接口 migrate 一致的前端兜底）
    catalog.modules.forEach((mod, i) => {
      if (mod.references?.length) {
        for (const r of mod.references) {
          const path = String(r.path || '');
          const exists = catalog.references.some(
            (x) => (path && x.path === path) || x.id === r.id,
          );
          if (!exists) catalog.references.push({ ...r });
        }
        mod.references = [];
      }
      // 缺省标识时自动补全（不覆盖已有 slug）
      if (!mod.slug || !/^[a-z][a-z0-9-]{0,47}$/.test(String(mod.slug))) {
        mod.slug = uniqueModSlug(normalizeModSlug(mod.id, `mod-${uid('m')}`), i);
        if (!mod.id) mod.id = mod.slug;
        setDirty(true);
      }
      mod.statusLabel = statusLabelFor(mod.status);
      if (!mod.shortTitle) mod.shortTitle = mod.title || '';
    });
    backfillModuleSections();
    window.__OPS_CATALOG__ = catalog;
    view = 'structure';
    editPath = null;
    sideMode = 'module';
    setDirty(false);
    renderModuleList();
    renderEditor();
    refreshPassagesStatus().catch(() => {});
  }

  async function refreshPassagesStatus() {
    const el = $('passages-summary');
    const msg = $('passages-msg');
    if (!el) return;
    try {
      const data = await api('/api/passages');
      const pending = (data.missing || 0) + (data.stale || 0);
      const readyHint = data.hybridReady ? '混合检索可用' : '索引未就绪（请预热）';
      el.textContent = `${readyHint} · 段落 ${data.passages || 0} · 课就绪 ${data.ready || 0} · 待建 ${pending} · ${data.updatedAt ? String(data.updatedAt).slice(0, 19).replace('T', ' ') : ''}`;
      if (msg && !msg.dataset.sticky) msg.hidden = true;
    } catch (e) {
      el.textContent = e.message || '问答索引状态加载失败';
    }
  }

  async function warmPassagesBatch() {
    const msg = $('passages-msg');
    showMsg(msg, '正在重建索引…', true);
    if (msg) msg.dataset.sticky = '1';
    try {
      const data = await api('/api/passages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'warm', limit: 12 }),
      });
      showMsg(
        msg,
        data.done
          ? `索引已就绪：段落 ${data.totalPassages || data.passages || 0}。`
          : `本批处理 ${data.processed || 0} 课，写入 ${data.upserted || 0} 段，剩余约 ${data.left ?? '?'} 课。可再点预热。`,
        true,
      );
      await refreshPassagesStatus();
    } catch (e) {
      showMsg(msg, e.message || String(e), false);
    } finally {
      if (msg) delete msg.dataset.sticky;
    }
  }

  function currentModule() {
    return catalog?.modules?.[moduleIndex] || null;
  }

  function lessonStatus(les) {
    const hasText = !!(les.text && String(les.text).trim());
    const hasAudio = !!(les.audioPath && String(les.audioPath).trim());
    const hasVideo = !!(les.videoPath && String(les.videoPath).trim());
    const badges = [];
    if (hasText) badges.push('<span class="ops-badge" title="有文字">文</span>');
    if (hasAudio) badges.push('<span class="ops-badge ops-badge--audio" title="有音频">音</span>');
    if (hasVideo) badges.push('<span class="ops-badge ops-badge--video" title="有视频">视</span>');
    if (!badges.length) badges.push('<span class="ops-badge ops-badge--empty">空</span>');
    return badges.join('');
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureNavFilters() {
    if (navFilterReady) return;
    navFilterReady = true;
    $('mod-search')?.addEventListener('input', (e) => {
      modSearch = String(e.target.value || '').trim().toLowerCase();
      renderModuleList();
    });
    $('mod-status-filter')?.addEventListener('change', (e) => {
      modStatusFilter = e.target.value || 'all';
      renderModuleList();
    });
  }

  function moduleMatchesFilter(mod) {
    if (!mod) return false;
    if (modStatusFilter === 'open' && mod.status !== 'open') return false;
    if (modStatusFilter === 'coming' && mod.status !== 'coming') return false;
    if (!modSearch) return true;
    const hay = `${mod.title || ''} ${mod.shortTitle || ''} ${mod.slug || ''}`.toLowerCase();
    return hay.includes(modSearch);
  }

  function sectionContainsModule(sec, modOrSlug) {
    const mod =
      typeof modOrSlug === 'string'
        ? catalog.modules.find((m) => m.slug === modOrSlug)
        : modOrSlug;
    if (!mod) return false;
    return resolveOpsModSection(mod).section === sec.title;
  }

  function findSectionTitleForMod(mod) {
    const sec = resolveOpsModSection(mod).section;
    return sec || '其他';
  }

  function renderModButton(i) {
    const m = catalog.modules[i];
    if (!m) return '';
    const active = sideMode === 'module' && i === moduleIndex;
    const status = m.status === 'open' ? '开放中' : '即将开放';
    return `<li>
      <button type="button" class="ops-nav-mod ${active ? 'is-active' : ''}" data-i="${i}">
        ${escapeHtml(m.title || m.slug || '未命名')}
        <span class="ops-nav-mod__meta">${status}</span>
      </button>
    </li>`;
  }

  function renderModsForSection(sec, used) {
    if (sec.groups?.length) {
      const known = new Set(sec.groups.map((g) => g.title));
      const blocks = sec.groups
        .map((g) => {
          const idxs = catalog.modules
            .map((_, i) => i)
            .filter((i) => {
              if (used.has(i)) return false;
              const p = resolveOpsModSection(catalog.modules[i]);
              return p.section === sec.title && p.group === g.title;
            });
          idxs.forEach((i) => used.add(i));
          const items = idxs
            .filter((i) => moduleMatchesFilter(catalog.modules[i]))
            .map(renderModButton)
            .join('');
          if (!items) return '';
          return `<div class="ops-nav-sub"><p class="ops-nav-sub__title">${escapeHtml(g.title)}</p><ul class="ops-nav-group__body">${items}</ul></div>`;
        })
        .join('');
      const orphanIdxs = catalog.modules
        .map((_, i) => i)
        .filter((i) => {
          if (used.has(i)) return false;
          const p = resolveOpsModSection(catalog.modules[i]);
          return p.section === sec.title && !known.has(p.group);
        });
      orphanIdxs.forEach((i) => used.add(i));
      const orphanItems = orphanIdxs
        .filter((i) => moduleMatchesFilter(catalog.modules[i]))
        .map(renderModButton)
        .join('');
      const orphanBlock = orphanItems
        ? `<div class="ops-nav-sub"><p class="ops-nav-sub__title">其他</p><ul class="ops-nav-group__body">${orphanItems}</ul></div>`
        : '';
      return blocks + orphanBlock;
    }
    const idxs = catalog.modules
      .map((_, i) => i)
      .filter((i) => {
        if (used.has(i)) return false;
        return resolveOpsModSection(catalog.modules[i]).section === sec.title;
      });
    idxs.forEach((i) => used.add(i));
    return `<ul class="ops-nav-group__body">${idxs
      .filter((i) => moduleMatchesFilter(catalog.modules[i]))
      .map(renderModButton)
      .join('')}</ul>`;
  }

  function updateWorkspaceChrome() {
    const grid = $('ops-grid');
    grid?.classList.toggle('is-materials', sideMode === 'refs' || sideMode === 'articles');
    // 更新 workspace 相关的 tab 激活状态
    document.querySelectorAll('.ops-tab[data-group="workspace"]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === sideMode);
    });
    updateSaveButton();
    updateContextHeader();
  }

  function updateContextHeader() {
    const label = $('ops-ctx-label');
    const title = $('ops-ctx-title');
    if (!label || !title) return;
    if (sideMode === 'refs') {
      label.textContent = '参考书籍';
      if (refsEditIndex != null && catalog?.references?.[refsEditIndex]) {
        title.textContent = `编辑：${catalog.references[refsEditIndex].title || '未命名'}`;
      } else {
        title.textContent = '书籍列表';
      }
      return;
    }
    if (sideMode === 'articles') {
      label.textContent = '公众号好文';
      if (acolEditIndex != null && articleCollections?.[acolEditIndex]) {
        title.textContent = `编辑：${articleCollections[acolEditIndex].title || '未命名集合'}`;
      } else {
        title.textContent = '集合列表';
      }
      return;
    }
    label.textContent = '学修';
    const mod = currentModule();
    if (!mod) {
      title.textContent = '请选择模块';
      return;
    }
    const lesson =
      view === 'lesson' && editPath
        ? mod.chapters?.[editPath.ci]?.lessons?.[editPath.li]
        : null;
    title.textContent = lesson
      ? `${mod.title} · ${lesson.title || '未命名课'}`
      : mod.title || '未命名模块';
  }

  function switchWorkspace(mode) {
    if (mode === sideMode) return;
    if (sideMode === 'articles' && mode !== 'articles' && articlesDirty) {
      if (!confirm('公众号好文有未保存修改，切换将丢失。仍要切换？')) return;
    }
    if (sideMode !== 'articles' && mode !== sideMode && dirty) {
      if (!confirm('学修有未保存修改，切换分区将丢失这些修改（除非已保存）。仍要切换？')) return;
    }
    sideMode = mode;
    view = 'structure';
    editPath = null;
    refsEditIndex = null;
    acolEditIndex = null;
    renderModuleList();
    renderEditor();
    refreshDirtyBanner();
    updateWorkspaceChrome();
  }

  function selectModule(i) {
    if (sideMode === 'module' && i === moduleIndex && view === 'structure') return;
    if (dirty && !(sideMode === 'module' && i === moduleIndex)) {
      if (!confirm('当前有未保存修改，切换将丢失这些修改（除非你已保存）。仍要切换？')) return;
    }
    sideMode = 'module';
    moduleIndex = i;
    view = 'structure';
    editPath = null;
    const mod = catalog.modules[i];
    if (mod) collapsedNavGroups.delete(findSectionTitleForMod(mod));
    renderModuleList();
    renderEditor();
    refreshDirtyBanner();
    updateWorkspaceChrome();
  }

  function isGroupCollapsed(title, hasCurrent) {
    if (modSearch) return false;
    if (hasCurrent) return false;
    if (!renderModuleList._collapseInited) return true;
    return collapsedNavGroups.has(title);
  }

  function renderModuleList() {
    ensureNavFilters();
    if (!catalog?.modules) {
      moduleList.innerHTML = '';
      return;
    }

    const used = new Set();
    const parts = [];
    const currentMod = catalog.modules[moduleIndex];

    for (const sec of OPS_SECTIONS) {
      const body = renderModsForSection(sec, used);
      if (!String(body).includes('ops-nav-mod')) continue;

      const hasCurrent = sideMode === 'module' && sectionContainsModule(sec, currentMod);
      const collapsed = isGroupCollapsed(sec.title, hasCurrent);
      if (collapsed) collapsedNavGroups.add(sec.title);
      else collapsedNavGroups.delete(sec.title);

      parts.push(`
        <div class="ops-nav-group ${collapsed ? 'is-collapsed' : ''}">
          <button type="button" class="ops-nav-group__head" data-toggle-group="${escapeHtml(sec.title)}">
            <span>${escapeHtml(sec.title)}</span>
            <span>${collapsed ? '▸' : '▾'}</span>
          </button>
          <div class="ops-nav-group__body-wrap">${body}</div>
        </div>`);
    }

    const otherIdx = catalog.modules
      .map((_, i) => i)
      .filter(
        (i) =>
          !used.has(i) &&
          !resolveOpsModSection(catalog.modules[i]).section &&
          moduleMatchesFilter(catalog.modules[i]),
      );
    if (otherIdx.length) {
      const title = '其他';
      const hasCurrent = sideMode === 'module' && otherIdx.includes(moduleIndex);
      const collapsed = isGroupCollapsed(title, hasCurrent);
      if (collapsed) collapsedNavGroups.add(title);
      else collapsedNavGroups.delete(title);
      parts.push(`
        <div class="ops-nav-group ${collapsed ? 'is-collapsed' : ''}">
          <button type="button" class="ops-nav-group__head" data-toggle-group="${title}">
            <span>${title}</span>
            <span>${collapsed ? '▸' : '▾'}</span>
          </button>
          <ul class="ops-nav-group__body">${otherIdx.map(renderModButton).join('')}</ul>
        </div>`);
    }

    renderModuleList._collapseInited = true;
    moduleList.innerHTML = parts.length
      ? parts.join('')
      : '<p class="ops-empty ops-empty--sm">无匹配模块</p>';

    moduleList.querySelectorAll('[data-toggle-group]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.toggleGroup;
        renderModuleList._collapseInited = true;
        if (collapsedNavGroups.has(name)) collapsedNavGroups.delete(name);
        else collapsedNavGroups.add(name);
        renderModuleList();
      });
    });

    moduleList.querySelectorAll('.ops-nav-mod[data-i]').forEach((btn) => {
      btn.addEventListener('click', () => selectModule(Number(btn.dataset.i)));
    });

    updateWorkspaceChrome();
  }

  function updateSaveButton() {
    const btn = $('btn-save');
    if (!btn) return;
    btn.textContent = sideMode === 'articles' ? '保存好文' : '保存到服务器';
  }

  function renderEditor() {
    updateWorkspaceChrome();
    if (sideMode === 'refs') {
      renderReferencesView();
      return;
    }
    if (sideMode === 'articles') {
      renderArticleCollectionsView();
      return;
    }

    const mod = currentModule();
    if (!mod) {
      editor.innerHTML =
        '<p class="ops-empty">暂无模块。请点击左侧「+ 添加」，或从已有模块进入编辑。</p>';
      updateContextHeader();
      return;
    }
    if (!mod.chapters) mod.chapters = [];

    if (view === 'lesson' && editPath) {
      renderLessonView(mod);
      updateContextHeader();
      return;
    }
    renderStructureView(mod);
    updateContextHeader();
  }

  function renderArticleCollectionsView() {
    if (!Array.isArray(articleCollections)) articleCollections = [];
    const cols = articleCollections;
    updateSaveButton();

    if (acolEditIndex != null && !cols[acolEditIndex]) acolEditIndex = null;

    if (acolEditIndex == null) {
      editor.innerHTML = `
        <p class="ops-label">公众号好文</p>
        <p class="ops-empty" style="margin-top:0;">
          先从列表进入某一集合再编辑。链接型集合点开即外链；文字型集合可再维护文章。此处单独保存。
        </p>
        <div class="ops-row">
          <button type="button" class="btn ops-mini" id="add-acol" style="color:inherit;border-color:var(--line);">+ 添加集合</button>
        </div>
        <ul class="ops-pick-list" id="acols-box"></ul>
      `;
      const box = $('acols-box');
      box.innerHTML = cols.length
        ? cols
            .map((col, i) => {
              const kind = col.kind === 'link' ? '链接型' : '文字型';
              const n = (col.articles || []).length;
              const meta =
                col.kind === 'link'
                  ? col.url
                    ? '已填链接'
                    : '未填链接'
                  : n
                    ? `${n} 篇文章`
                    : '暂无文章';
              return `
                <li class="ops-pick-item">
                  <button type="button" class="ops-pick-main" data-edit-acol="${i}">
                    <strong>${escapeHtml(col.title || '未命名集合')}</strong>
                    <span>${kind} · ${escapeHtml(meta)}</span>
                  </button>
                  <span class="ops-pick-actions">
                    <button type="button" class="btn ops-mini ops-move" data-acol-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="btn ops-mini ops-move" data-acol-down="${i}" ${i >= cols.length - 1 ? 'disabled' : ''}>↓</button>
                  </span>
                </li>`;
            })
            .join('')
        : '<li class="ops-empty">暂无集合，请添加。</li>';

      $('add-acol')?.addEventListener('click', () => {
        cols.push({
          id: uid('acol'),
          title: `新集合 ${cols.length + 1}`,
          kind: 'text',
          url: '',
          note: '',
          articles: [],
        });
        acolEditIndex = cols.length - 1;
        setArticlesDirty(true);
        renderArticleCollectionsView();
      });
      box.querySelectorAll('[data-edit-acol]').forEach((btn) => {
        btn.addEventListener('click', () => {
          acolEditIndex = Number(btn.dataset.editAcol);
          renderArticleCollectionsView();
        });
      });
      box.querySelectorAll('[data-acol-up]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.acolUp);
          if (i <= 0) return;
          const [item] = cols.splice(i, 1);
          cols.splice(i - 1, 0, item);
          setArticlesDirty(true);
          renderArticleCollectionsView();
        });
      });
      box.querySelectorAll('[data-acol-down]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = Number(btn.dataset.acolDown);
          if (i >= cols.length - 1) return;
          const [item] = cols.splice(i, 1);
          cols.splice(i + 1, 0, item);
          setArticlesDirty(true);
          renderArticleCollectionsView();
        });
      });
      updateContextHeader();
      return;
    }

    const i = acolEditIndex;
    const col = cols[i];
    const kind = col.kind === 'link' ? 'link' : 'text';
    const articles = Array.isArray(col.articles) ? col.articles : [];

    editor.innerHTML = `
      <div class="ops-row">
        <button type="button" class="btn ops-mini" id="back-acol-list" style="color:inherit;border-color:var(--line);">← 返回列表</button>
        <button type="button" class="btn ops-mini" id="del-acol" style="color:inherit;border-color:var(--line);">删除集合</button>
      </div>
      <p class="ops-label">编辑集合</p>
      <label class="ops-field">集合名称<input id="acol-title" value="${escapeHtml(col.title || '')}" /></label>
      <label class="ops-field">类型
        <select id="acol-kind">
          <option value="text" ${kind === 'text' ? 'selected' : ''}>文字型（进入文章列表）</option>
          <option value="link" ${kind === 'link' ? 'selected' : ''}>链接型（集合本身即超链接）</option>
        </select>
      </label>
      ${
        kind === 'link'
          ? `<label class="ops-field">集合超链接<input id="acol-url" value="${escapeHtml(col.url || '')}" placeholder="https://..." /></label>`
          : ''
      }
      <label class="ops-field">说明（可选）<input id="acol-note" value="${escapeHtml(col.note || '')}" /></label>
      ${
        kind === 'text'
          ? `
        <div class="ops-acol-articles">
          <div class="ops-row" style="margin-top:0;">
            <p class="ops-label" style="margin:0;flex:1;">集合内文章</p>
            <button type="button" class="btn ops-mini" id="add-art" style="color:inherit;border-color:var(--line);">+ 添加文章</button>
          </div>
          <div id="arts-box"></div>
        </div>`
          : '<p class="ops-empty ops-empty--sm">链接型集合无需添加文章，前台点击集合标题即打开上方超链接。</p>'
      }
    `;

    $('back-acol-list')?.addEventListener('click', () => {
      acolEditIndex = null;
      renderArticleCollectionsView();
    });
    $('del-acol')?.addEventListener('click', () => {
      if (!confirm('确定删除该集合及其文章？')) return;
      cols.splice(i, 1);
      acolEditIndex = null;
      setArticlesDirty(true);
      renderArticleCollectionsView();
    });

    const bindField = (id, field, rerenderOnChange = false) => {
      const el = $(id);
      if (!el) return;
      const handler = () => {
        col[field] = el.value;
        if (field === 'kind') {
          if (col.kind !== 'link') col.kind = 'text';
          if (col.kind === 'link') col.articles = [];
          else if (!Array.isArray(col.articles)) col.articles = [];
        }
        setArticlesDirty(true);
        updateContextHeader();
        if (rerenderOnChange) renderArticleCollectionsView();
      };
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', handler);
    };
    bindField('acol-title', 'title');
    bindField('acol-kind', 'kind', true);
    bindField('acol-url', 'url');
    bindField('acol-note', 'note');

    if (kind === 'text') {
      const box = $('arts-box');
      box.innerHTML = articles.length
        ? articles
            .map(
              (art, j) => `
            <div class="ops-tree-item ops-tree-item--lesson">
              <div class="ops-tree-body" style="grid-column:1/-1;">
                <label class="ops-field">名称<input data-art-field="${j}:title" value="${escapeHtml(art.title || '')}" /></label>
                <label class="ops-field">超链接<input data-art-field="${j}:url" value="${escapeHtml(art.url || '')}" placeholder="https://mp.weixin.qq.com/..." /></label>
                <label class="ops-field">备注（可选）<input data-art-field="${j}:note" value="${escapeHtml(art.note || '')}" /></label>
                <div class="ops-tree-actions">
                  <button type="button" class="btn ops-mini" data-del-art="${j}" style="color:inherit;border-color:var(--line);">删除文章</button>
                </div>
              </div>
            </div>`,
            )
            .join('')
        : '<p class="ops-empty ops-empty--sm">暂无文章，请添加。</p>';

      $('add-art')?.addEventListener('click', () => {
        if (!Array.isArray(col.articles)) col.articles = [];
        col.articles.push({
          id: uid('art'),
          title: `新文章 ${col.articles.length + 1}`,
          url: '',
          note: '',
        });
        setArticlesDirty(true);
        renderArticleCollectionsView();
      });
      box.querySelectorAll('[data-art-field]').forEach((input) => {
        input.addEventListener('input', () => {
          const [j, field] = input.dataset.artField.split(':');
          const art = col.articles?.[Number(j)];
          if (!art) return;
          art[field] = input.value;
          setArticlesDirty(true);
        });
      });
      box.querySelectorAll('[data-del-art]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const j = Number(btn.dataset.delArt);
          if (!confirm('确定删除该文章？')) return;
          col.articles.splice(j, 1);
          setArticlesDirty(true);
          renderArticleCollectionsView();
        });
      });
    }
    updateContextHeader();
  }

  function renderReferencesView() {
    if (!Array.isArray(catalog.references)) catalog.references = [];
    const refs = catalog.references;
    if (refsEditIndex != null && !refs[refsEditIndex]) refsEditIndex = null;

    if (refsEditIndex == null) {
      editor.innerHTML = `
        <p class="ops-label">参考书籍</p>
        <p class="ops-empty" style="margin-top:0;">先从列表进入某一本书再编辑标题、说明与 PDF。</p>
        <div class="ops-row">
          <button type="button" class="btn ops-mini" id="add-ref" style="color:inherit;border-color:var(--line);">+ 添加书籍</button>
        </div>
        <ul class="ops-pick-list" id="refs-box"></ul>
      `;
      const box = $('refs-box');
      box.innerHTML = refs.length
        ? refs
            .map((ref, i) => {
              const hasFile = !!String(ref.path || '').trim();
              return `
                <li class="ops-pick-item">
                  <button type="button" class="ops-pick-main" data-edit-ref="${i}">
                    <strong>${escapeHtml(ref.title || '未命名')}</strong>
                    <span>${escapeHtml(ref.meta || (hasFile ? '已上传文件' : '尚未上传'))}</span>
                  </button>
                </li>`;
            })
            .join('')
        : '<li class="ops-empty">暂无参考书籍，请添加。</li>';

      $('add-ref')?.addEventListener('click', () => {
        refs.push({
          id: uid('ref'),
          title: `新资料 ${refs.length + 1}`,
          meta: '',
          path: '',
        });
        refsEditIndex = refs.length - 1;
        setDirty(true);
        renderReferencesView();
      });
      box.querySelectorAll('[data-edit-ref]').forEach((btn) => {
        btn.addEventListener('click', () => {
          refsEditIndex = Number(btn.dataset.editRef);
          renderReferencesView();
        });
      });
      updateContextHeader();
      return;
    }

    const i = refsEditIndex;
    const ref = refs[i];
    const url = assetUrl(ref.path);

    editor.innerHTML = `
      <div class="ops-row">
        <button type="button" class="btn ops-mini" id="back-ref-list" style="color:inherit;border-color:var(--line);">← 返回列表</button>
        <button type="button" class="btn ops-mini" id="del-ref" style="color:inherit;border-color:var(--line);">删除</button>
      </div>
      <p class="ops-label">编辑书籍</p>
      <label class="ops-field">标题<input id="ref-title" value="${escapeHtml(ref.title || '')}" /></label>
      <label class="ops-field">说明 / 作者<input id="ref-meta" value="${escapeHtml(ref.meta || '')}" /></label>
      <label class="ops-field">文件路径<input id="ref-path" value="${escapeHtml(ref.path || '')}" /></label>
      ${
        ref.path && url
          ? `<div class="ops-preview"><a class="ops-preview-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">打开已上传文件</a></div>`
          : ref.path
            ? `<p class="ops-empty ops-empty--sm">已有路径，但未配置 PUBLIC_R2_BASE，无法预览。</p>`
            : `<p class="ops-empty ops-empty--sm">尚未上传文件。</p>`
      }
      <div class="ops-upload-panel">
        <input type="file" accept=".pdf,application/pdf" id="ref-upload" />
        <div class="ops-upload-status" id="ref-upload-status" hidden></div>
        <div class="ops-progress" id="ref-progress" hidden>
          <div class="ops-progress-bar" id="ref-progress-bar"></div>
        </div>
      </div>
    `;

    $('back-ref-list')?.addEventListener('click', () => {
      refsEditIndex = null;
      renderReferencesView();
    });
    $('del-ref')?.addEventListener('click', () => {
      if (!confirm('确定删除该参考资料？')) return;
      refs.splice(i, 1);
      refsEditIndex = null;
      setDirty(true);
      renderReferencesView();
    });
    $('ref-title')?.addEventListener('input', (e) => {
      ref.title = e.target.value;
      setDirty(true);
      updateContextHeader();
    });
    $('ref-meta')?.addEventListener('input', (e) => {
      ref.meta = e.target.value;
      setDirty(true);
    });
    $('ref-path')?.addEventListener('input', (e) => {
      ref.path = e.target.value;
      setDirty(true);
    });

    $('ref-upload')?.addEventListener('change', async () => {
      const input = $('ref-upload');
      const file = input?.files?.[0];
      if (!file) return;
      const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'pdf';
      const safe =
        file.name
          .replace(/\.[^.]+$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 48) || `book-${uid('b')}`;
      const key = ref.path || `books/${safe}.${ext}`;
      ref.path = key;
      const status = $('ref-upload-status');
      const progress = $('ref-progress');
      const bar = $('ref-progress-bar');
      try {
        if (status) {
          status.hidden = false;
          status.textContent = `上传中：${file.name}`;
          status.classList.remove('is-error');
          status.classList.add('is-ok');
        }
        if (progress && bar) {
          progress.hidden = false;
          bar.style.width = '0%';
        }
        showMsg(saveMsg, '正在上传参考资料…', true);
        await uploadFile(key, file, (done, total) => {
          const pct = Math.min(100, Math.round((done / total) * 100));
          if (status) status.textContent = `上传中 ${pct}% · ${file.name}`;
          if (bar) bar.style.width = `${pct}%`;
        });
        if (status) status.textContent = `上传完成：${key}`;
        if (progress) progress.hidden = true;
        showMsg(saveMsg, '上传完成，正在自动保存…', true);
        await saveCatalog({ reason: `参考资料已上传并保存：${key}` });
        renderReferencesView();
      } catch (e) {
        if (status) {
          status.hidden = false;
          status.textContent = String(e.message || e);
          status.classList.add('is-error');
          status.classList.remove('is-ok');
        }
        if (progress) progress.hidden = true;
        showMsg(saveMsg, String(e.message || e), false);
      } finally {
        if (input) input.value = '';
      }
    });
    updateContextHeader();
  }

  function renderStructureView(mod) {
    editor.innerHTML = `
      <div class="ops-row">
        <p class="ops-label" style="margin:0;flex:1;">模块设置</p>
        <span class="ops-move-btns">
          <button type="button" class="btn ops-mini ops-move" id="mod-move-up" title="模块上移" ${moduleIndex === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn ops-mini ops-move" id="mod-move-down" title="模块下移" ${moduleIndex >= catalog.modules.length - 1 ? 'disabled' : ''}>↓</button>
        </span>
        <button type="button" class="btn ops-mini" id="del-module" style="color:inherit;border-color:var(--line);">删除模块</button>
      </div>
      <label class="ops-field">标题<input data-mod="title" value="${escapeHtml(mod.title)}" /></label>
      <p class="ops-hint">系统标识：${escapeHtml(mod.slug || '')}（自动生成）</p>
      <label class="ops-field">状态
        <select data-mod="status">
          <option value="open" ${mod.status === 'open' ? 'selected' : ''}>开放中</option>
          <option value="coming" ${mod.status === 'coming' ? 'selected' : ''}>即将开放</option>
        </select>
      </label>
      ${(() => {
        const place = resolveOpsModSection(mod);
        const secVal = mod.section === '未归类' ? '未归类' : place.section || '未归类';
        const groupVal = place.group || '';
        const secOpts = ['未归类', ...OPS_SECTION_TITLES]
          .map(
            (t) =>
              `<option value="${escapeHtml(t)}" ${secVal === t ? 'selected' : ''}>${escapeHtml(t)}</option>`,
          )
          .join('');
        const groupOpts = ['', ...OPS_PRO_GROUPS]
          .map(
            (t) =>
              `<option value="${escapeHtml(t)}" ${groupVal === t ? 'selected' : ''}>${
                t ? escapeHtml(t) : '（无子组）'
              }</option>`,
          )
          .join('');
        return `
      <label class="ops-field">学修分区
        <select data-mod="section" id="mod-section">${secOpts}</select>
      </label>
      <label class="ops-field" id="mod-section-group-wrap" ${
        secVal === '专业课' ? '' : 'hidden'
      }>专业课子组
        <select data-mod="sectionGroup" id="mod-section-group">${groupOpts}</select>
      </label>
      <p class="ops-hint">分区决定前台学修页出现位置；选「未归类」则出现在「未归类」。</p>`;
      })()}
      <label class="ops-field">摘要<textarea data-mod="summary" rows="3">${escapeHtml(mod.summary || '')}</textarea></label>

      <div class="ops-row">
        <p class="ops-label" style="margin:0;flex:1;">课程结构（按住左侧 ⋮⋮ 拖动排序）</p>
        <button type="button" class="btn ops-mini" style="color:inherit;border-color:var(--line);" id="add-chapter">+ 添加章节</button>
      </div>
      <div id="chapters-box" class="ops-tree"></div>
    `;

    $('mod-move-up')?.addEventListener('click', () => {
      if (moduleIndex <= 0) return;
      moveInArray(catalog.modules, moduleIndex, moduleIndex - 1);
      moduleIndex -= 1;
      setDirty(true);
      renderModuleList();
      renderEditor();
    });
    $('mod-move-down')?.addEventListener('click', () => {
      if (moduleIndex >= catalog.modules.length - 1) return;
      moveInArray(catalog.modules, moduleIndex, moduleIndex + 1);
      moduleIndex += 1;
      setDirty(true);
      renderModuleList();
      renderEditor();
    });
    $('del-module')?.addEventListener('click', () => {
      if (!confirm(`确定删除模块「${mod.title}」及其全部章节与课？此操作保存后才会生效到服务器。`)) return;
      catalog.modules.splice(moduleIndex, 1);
      moduleIndex = Math.max(0, moduleIndex - 1);
      view = 'structure';
      editPath = null;
      setDirty(true);
      renderModuleList();
      renderEditor();
    });

    editor.querySelectorAll('[data-mod]').forEach((input) => {
      const onChange = () => {
        const key = input.getAttribute('data-mod');
        mod[key] = input.value;
        if (key === 'status') {
          mod.statusLabel = statusLabelFor(input.value);
        }
        if (key === 'title') mod.shortTitle = input.value;
        if (key === 'summary') mod.intro = input.value;
        if (key === 'section') {
          if (input.value !== '专业课') mod.sectionGroup = '';
          const wrap = $('mod-section-group-wrap');
          if (wrap) wrap.hidden = input.value !== '专业课';
          const gSel = $('mod-section-group');
          if (gSel && input.value !== '专业课') gSel.value = '';
        }
        setDirty(true);
        if (key === 'title' || key === 'status' || key === 'section' || key === 'sectionGroup') {
          renderModuleList();
        }
        if (key === 'section') updateContextHeader();
      };
      input.addEventListener('change', onChange);
      input.addEventListener('input', () => {
        const key = input.getAttribute('data-mod');
        if (key === 'status' || key === 'section' || key === 'sectionGroup') return;
        mod[key] = input.value;
        if (key === 'title') mod.shortTitle = input.value;
        if (key === 'summary') mod.intro = input.value;
        setDirty(true);
        if (key === 'title') renderModuleList();
      });
    });

    // 打开编辑时校正状态文案
    mod.statusLabel = statusLabelFor(mod.status);

    $('add-chapter')?.addEventListener('click', () => {
      mod.chapters.push({
        id: uid('ch'),
        title: `新章节 ${mod.chapters.length + 1}`,
        lessons: [],
      });
      setDirty(true);
      renderEditor();
    });

    renderChapterTree(mod);
  }

  function renderChapterTree(mod) {
    const box = $('chapters-box');
    if (!box) return;

    if (!mod.chapters.length) {
      box.innerHTML = '<p class="ops-empty">暂无章节。例如可添加「闻法方式」「共同外前行」。</p>';
      return;
    }

    box.innerHTML = mod.chapters
      .map((ch, ci) => {
        if (!ch.id) ch.id = uid('ch');
        const lessonCount = (ch.lessons || []).length;
        const expanded = expandedChapterIds.has(ch.id);
        const lessons = expanded
          ? (ch.lessons || [])
              .map((les, li) => {
                return `
              <div class="ops-tree-item ops-tree-item--lesson" data-drag="lesson" data-ci="${ci}" data-li="${li}">
                <span class="ops-drag" role="button" tabindex="0" title="按住拖动排序" aria-label="拖动排序课次">⋮⋮</span>
                <div class="ops-tree-body">
                  <div class="ops-tree-line">
                    <strong class="ops-tree-label">课 ${li + 1}</strong>
                    <input class="ops-inline-input" data-les-title="${ci}:${li}" value="${escapeHtml(les.title)}" />
                    <span class="ops-badges">${lessonStatus(les)}</span>
                  </div>
                  <label class="ops-field ops-field--compact">摘要<input data-les-summary="${ci}:${li}" value="${escapeHtml(les.summary || '')}" /></label>
                  <div class="ops-tree-actions">
                    <button type="button" class="btn ops-mini ops-move-text" data-act="move-lesson" data-dir="-1" data-ci="${ci}" data-li="${li}" ${li === 0 ? 'disabled' : ''}>上移</button>
                    <button type="button" class="btn ops-mini ops-move-text" data-act="move-lesson" data-dir="1" data-ci="${ci}" data-li="${li}" ${li >= (ch.lessons || []).length - 1 ? 'disabled' : ''}>下移</button>
                    <button type="button" class="btn ops-mini" data-act="edit-lesson" data-ci="${ci}" data-li="${li}" style="color:inherit;border-color:var(--line);">编辑内容</button>
                    <button type="button" class="btn ops-mini" data-act="del-lesson" data-ci="${ci}" data-li="${li}" style="color:inherit;border-color:var(--line);">删除课</button>
                  </div>
                </div>
              </div>`;
              })
              .join('')
          : '';

        return `
          <div class="ops-tree-item ops-tree-item--chapter ${expanded ? 'is-expanded' : 'is-collapsed'}" data-drag="chapter" data-ci="${ci}" data-ch-id="${escapeHtml(ch.id)}">
            <span class="ops-drag" role="button" tabindex="0" title="按住拖动排序" aria-label="拖动排序章节">⋮⋮</span>
            <div class="ops-tree-body">
              <div class="ops-chapter-head">
                <div class="ops-chapter-head__main">
                  <strong class="ops-tree-label">章节 ${ci + 1}</strong>
                  <input class="ops-inline-input" data-ch-title="${ci}" value="${escapeHtml(ch.title)}" />
                  <span class="ops-chapter-count">${lessonCount} 课</span>
                </div>
                <button type="button" class="btn ops-mini" data-act="toggle-chapter" data-ci="${ci}" style="color:inherit;border-color:var(--line);">${expanded ? '收起课次' : '展开课次'}</button>
              </div>
              <div class="ops-tree-actions ops-chapter-actions">
                <button type="button" class="btn ops-mini ops-move-text" data-act="move-chapter" data-dir="-1" data-ci="${ci}" ${ci === 0 ? 'disabled' : ''}>上移</button>
                <button type="button" class="btn ops-mini ops-move-text" data-act="move-chapter" data-dir="1" data-ci="${ci}" ${ci >= mod.chapters.length - 1 ? 'disabled' : ''}>下移</button>
                ${expanded ? `<button type="button" class="btn ops-mini" data-act="add-lesson" data-ci="${ci}" style="color:inherit;border-color:var(--line);">+ 添加课</button>` : ''}
                <button type="button" class="btn ops-mini" data-act="del-chapter" data-ci="${ci}" style="color:inherit;border-color:var(--line);">删除章节</button>
              </div>
              ${
                expanded
                  ? `<div class="ops-tree-children" data-drop="lesson" data-ci="${ci}">
                ${lessons || '<p class="ops-empty ops-empty--sm">暂无课程，请添加。</p>'}
              </div>`
                  : ''
              }
            </div>
          </div>`;
      })
      .join('');

    box.querySelectorAll('[data-ch-title]').forEach((input) => {
      input.addEventListener('input', () => {
        mod.chapters[Number(input.dataset.chTitle)].title = input.value;
        setDirty(true);
      });
    });

    box.querySelectorAll('[data-les-title]').forEach((input) => {
      input.addEventListener('input', () => {
        const [ci, li] = input.dataset.lesTitle.split(':').map(Number);
        mod.chapters[ci].lessons[li].title = input.value;
        setDirty(true);
      });
    });

    box.querySelectorAll('[data-les-summary]').forEach((input) => {
      input.addEventListener('input', () => {
        const [ci, li] = input.dataset.lesSummary.split(':').map(Number);
        mod.chapters[ci].lessons[li].summary = input.value;
        setDirty(true);
      });
    });

    box.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ci = Number(btn.dataset.ci);
        const act = btn.dataset.act;

        if (act === 'toggle-chapter') {
          const ch = mod.chapters[ci];
          if (!ch?.id) return;
          if (expandedChapterIds.has(ch.id)) expandedChapterIds.delete(ch.id);
          else expandedChapterIds.add(ch.id);
          renderChapterTree(mod);
          return;
        }
        if (act === 'add-lesson') {
          const ch = mod.chapters[ci];
          if (ch?.id) expandedChapterIds.add(ch.id);
          const n = (ch.lessons ||= []).length + 1;
          const title = `第${n}课`;
          const slug = autoSlug(title, `lesson-${uid('l')}`);
          ch.lessons.push({
            id: uid('les'),
            slug,
            title,
            summary: '',
            text: '',
            audioPath: '',
            videoPath: '',
            videoPathSd: '',
          });
          setDirty(true);
          renderEditor();
        }
        if (act === 'del-chapter') {
          if (confirm('确定删除该章节及其下所有课？')) {
            const ch = mod.chapters[ci];
            if (ch?.id) expandedChapterIds.delete(ch.id);
            mod.chapters.splice(ci, 1);
            setDirty(true);
            renderEditor();
          }
        }
        if (act === 'del-lesson') {
          const li = Number(btn.dataset.li);
          if (confirm('确定删除该课？')) {
            mod.chapters[ci].lessons.splice(li, 1);
            setDirty(true);
            renderEditor();
          }
        }
        if (act === 'edit-lesson') {
          editPath = {
            ci,
            li: Number(btn.dataset.li),
          };
          view = 'lesson';
          renderEditor();
        }
        if (act === 'move-chapter') {
          const dir = Number(btn.dataset.dir);
          const to = ci + dir;
          if (to < 0 || to >= mod.chapters.length) return;
          moveInArray(mod.chapters, ci, to);
          setDirty(true);
          renderEditor();
        }
        if (act === 'move-lesson') {
          const li = Number(btn.dataset.li);
          const dir = Number(btn.dataset.dir);
          const list = mod.chapters[ci].lessons || [];
          const to = li + dir;
          if (to < 0 || to >= list.length) return;
          moveInArray(list, li, to);
          setDirty(true);
          renderEditor();
        }
      });
    });

    bindDragAndDrop(mod, box);
  }

  function bindDragAndDrop(mod, root) {
    let dragging = null;
    /** @type {'before' | 'after' | 'end'} */
    let dropPos = 'before';

    const clearDropMarks = () => {
      root.querySelectorAll('.is-drop-target, .is-drop-before, .is-drop-after').forEach((n) => {
        n.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after');
      });
    };

    root.querySelectorAll('[data-drag]').forEach((el) => {
      const handle = el.querySelector(':scope > .ops-drag');
      if (!handle) return;

      // 默认不可拖：避免点输入框/按钮时误触；仅按住把手时启用
      el.removeAttribute('draggable');

      const enableDrag = () => el.setAttribute('draggable', 'true');
      const disableDrag = () => el.removeAttribute('draggable');

      handle.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        enableDrag();
      });
      handle.addEventListener('pointerup', disableDrag);
      handle.addEventListener('pointercancel', disableDrag);

      el.addEventListener('dragstart', (e) => {
        if (el.getAttribute('draggable') !== 'true') {
          e.preventDefault();
          return;
        }
        dragging = {
          type: el.dataset.drag,
          ci: Number(el.dataset.ci),
          li: el.dataset.li != null ? Number(el.dataset.li) : null,
        };
        dropPos = 'before';
        el.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragging.type);
        // 透明拖影旁加一点偏移，避免挡住落点线
        try {
          e.dataTransfer.setDragImage(el, 24, 16);
        } catch (_) {}
        e.stopPropagation();
      });

      el.addEventListener('dragend', () => {
        disableDrag();
        el.classList.remove('is-dragging');
        clearDropMarks();
        dragging = null;
      });
    });

    root.querySelectorAll('[data-drag], [data-drop]').forEach((el) => {
      el.addEventListener('dragover', (e) => {
        if (!dragging) return;
        if (!isValidDropTarget(dragging, el)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';

        clearDropMarks();
        if (el.dataset.drop === 'lesson') {
          dropPos = 'end';
          el.classList.add('is-drop-target');
        } else {
          const rect = el.getBoundingClientRect();
          dropPos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          el.classList.add('is-drop-target');
          el.classList.add(dropPos === 'before' ? 'is-drop-before' : 'is-drop-after');
        }
      });

      el.addEventListener('dragleave', (e) => {
        // 进入子元素时也会 leave，只有真正离开节点才清
        if (e.relatedTarget && el.contains(e.relatedTarget)) return;
        el.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after');
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragging) return;
        if (!isValidDropTarget(dragging, el)) return;
        const from = dragging;
        const pos = dropPos;
        dragging = null;
        clearDropMarks();
        applyReorder(mod, from, el, pos);
        setDirty(true);
        renderEditor();
      });
    });
  }

  function isValidDropTarget(dragging, el) {
    const dragType = dragging.type;
    if (dragType === 'chapter') return el.dataset.drag === 'chapter';
    if (dragType === 'lesson') {
      return el.dataset.drag === 'lesson' || el.dataset.drop === 'lesson';
    }
    return false;
  }

  function moveInArray(arr, fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || toIndex > arr.length) return;
    const [item] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, item);
  }

  function applyReorder(mod, from, el, pos = 'before') {
    if (from.type === 'chapter' && el.dataset.drag === 'chapter') {
      let toCi = Number(el.dataset.ci);
      if (pos === 'after') toCi += 1;
      // 先移除，再按新下标插入
      if (from.ci < toCi) toCi -= 1;
      moveInArray(mod.chapters, from.ci, toCi);
      return;
    }

    if (from.type === 'lesson') {
      const srcList = mod.chapters[from.ci]?.lessons;
      if (!srcList) return;
      const [item] = srcList.splice(from.li, 1);
      if (!item) return;

      if (el.dataset.drop === 'lesson') {
        const toCi = Number(el.dataset.ci);
        (mod.chapters[toCi].lessons ||= []).push(item);
        return;
      }

      if (el.dataset.drag === 'lesson') {
        let toCi = Number(el.dataset.ci);
        let toLi = Number(el.dataset.li);
        if (pos === 'after') toLi += 1;
        // 同一章节内、从前往后拖时，源下标已 splice，目标需左移
        if (from.ci === toCi && from.li < toLi) toLi -= 1;
        (mod.chapters[toCi].lessons ||= []).splice(toLi, 0, item);
      }
    }
  }

  function renderLessonView(mod) {
    const { ci, li } = editPath;
    const ch = mod.chapters[ci];
    const les = ch?.lessons?.[li];
    if (!les) {
      view = 'structure';
      editPath = null;
      renderEditor();
      return;
    }

    const audioUrl = assetUrl(les.audioPath);
    const videoUrl = assetUrl(les.videoPath);
    const hasAudio = !!(les.audioPath && String(les.audioPath).trim());
    const hasVideo = !!(les.videoPath && String(les.videoPath).trim());

    editor.innerHTML = `
      <div class="ops-seg-page">
        <div class="ops-row" style="margin-top:0;">
          <button type="button" class="btn ops-mini" id="back-structure" style="color:inherit;border-color:var(--line);">← 返回结构</button>
          <p class="ops-crumb">${escapeHtml(ch.title)} / ${escapeHtml(les.title)}</p>
        </div>

        <p class="ops-label">课程内容</p>
        <label class="ops-field">文字<textarea id="les-text">${escapeHtml(les.text || '')}</textarea></label>

        <div class="ops-media-block" id="audio-block">
          <div class="ops-media-head">
            <p class="ops-label" style="margin:0;">音频</p>
            ${hasAudio ? '<span class="ops-status is-ok">已上传</span>' : '<span class="ops-status">未上传</span>'}
          </div>
          <label class="ops-field">存储路径<input id="les-audio-path" value="${escapeHtml(les.audioPath || '')}" /></label>
          ${
            hasAudio && audioUrl
              ? `<div class="ops-preview"><audio controls preload="metadata" src="${escapeHtml(audioUrl)}"></audio>
                   <a class="ops-preview-link" href="${escapeHtml(audioUrl)}" target="_blank" rel="noopener">打开链接</a></div>`
              : hasAudio
                ? `<p class="ops-empty ops-empty--sm">已有路径，但未配置 PUBLIC_R2_BASE，无法预览。</p>`
                : `<p class="ops-empty ops-empty--sm">尚未上传音频。</p>`
          }
          <div class="ops-upload-panel">
            <input type="file" accept="audio/*,.mp3" id="upload-audio" />
            <div class="ops-upload-status" id="audio-upload-status" hidden></div>
            <div class="ops-progress" id="audio-progress" hidden>
              <div class="ops-progress-bar" id="audio-progress-bar"></div>
            </div>
          </div>
        </div>

        <div class="ops-media-block" id="video-block">
          <div class="ops-media-head">
            <p class="ops-label" style="margin:0;">视频</p>
            ${hasVideo ? '<span class="ops-status is-ok">已上传</span>' : '<span class="ops-status">未上传</span>'}
          </div>
          <label class="ops-field">高清路径<input id="les-video-path" value="${escapeHtml(les.videoPath || '')}" /></label>
          <label class="ops-field">标清路径<input id="les-video-sd-path" value="${escapeHtml(les.videoPathSd || '')}" /></label>
          ${
            hasVideo && videoUrl
              ? `<div class="ops-preview"><video controls playsinline webkit-playsinline x5-playsinline preload="metadata" src="${escapeHtml(videoUrl)}"></video>
                   <a class="ops-preview-link" href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">打开链接</a></div>`
              : hasVideo
                ? `<p class="ops-empty ops-empty--sm">已有路径，但未配置 PUBLIC_R2_BASE，无法预览。</p>`
                : `<p class="ops-empty ops-empty--sm">尚未上传视频。</p>`
          }
          <div class="ops-upload-panel">
            <div class="ops-row" style="margin:0.15rem 0 0.35rem;">
              <a class="btn btn--solid ops-mini" style="color:#fbf6e6;" href="/api/download?path=media/jingtu-video-helper.zip">下载净土视频工作台</a>
              <a class="btn ops-mini" style="color:inherit;border-color:var(--line);" href="/tools/使用说明.txt" target="_blank" rel="noopener">使用说明</a>
            </div>
            <p class="ops-hint">
              请先用电脑上的工作台处理好再上传，网页不再转码。
              已是 480p 的片子请传到「高清」口（只保留一档）；另有标清时再传到「标清」口。
              替换高清会清空旧标清，避免学员默默播到旧片。
            </p>
            <p class="ops-label" style="margin:0.4rem 0 0.2rem;">上传高清</p>
            <input type="file" accept="video/*,.mp4" id="upload-video" />
            <div class="ops-upload-status" id="video-upload-status" hidden></div>
            <div class="ops-progress" id="video-progress" hidden>
              <div class="ops-progress-bar" id="video-progress-bar"></div>
            </div>
            <p class="ops-label" style="margin:0.8rem 0 0.2rem;">上传标清（可选）</p>
            <input type="file" accept="video/*,.mp4" id="upload-video-sd" />
            <div class="ops-upload-status" id="video-sd-upload-status" hidden></div>
            <div class="ops-progress" id="video-sd-progress" hidden>
              <div class="ops-progress-bar" id="video-sd-progress-bar"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    $('back-structure')?.addEventListener('click', () => {
      view = 'structure';
      editPath = null;
      renderEditor();
    });

    $('les-text')?.addEventListener('input', (e) => {
      les.text = e.target.value;
      setDirty(true);
    });
    $('les-audio-path')?.addEventListener('input', (e) => {
      les.audioPath = e.target.value;
      setDirty(true);
    });
    $('les-video-path')?.addEventListener('input', (e) => {
      les.videoPath = e.target.value;
      setDirty(true);
    });
    $('les-video-sd-path')?.addEventListener('input', (e) => {
      les.videoPathSd = e.target.value;
      setDirty(true);
    });

    bindUpload('audio', mod, les);
    bindUpload('video', mod, les);
    bindUpload('video-sd', mod, les);
  }

  function setUploadUi(kind, { pct, text, ok, error }) {
    const status = $(`${kind}-upload-status`);
    const progress = $(`${kind}-progress`);
    const bar = $(`${kind}-progress-bar`);
    if (status) {
      status.hidden = !text;
      status.textContent = text || '';
      status.classList.toggle('is-ok', !!ok && !error);
      status.classList.toggle('is-error', !!error);
    }
    if (progress && bar) {
      if (pct == null) {
        progress.hidden = true;
      } else {
        progress.hidden = false;
        bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      }
    }
  }

  function readAscii(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  async function inspectVideoFile(file) {
    const headSize = Math.min(file.size, 65536);
    const tailSize = Math.min(file.size, 2 * 1024 * 1024);
    const head = readAscii(await file.slice(0, headSize).arrayBuffer());
    const tail =
      file.size > headSize
        ? readAscii(await file.slice(Math.max(0, file.size - tailSize)).arrayBuffer())
        : head;
    const all = head + tail;
    const moov = head.indexOf('moov');
    const mdat = head.indexOf('mdat');
    const faststart = moov >= 0 && (mdat < 0 || moov < mdat);
    const hevc = /hvc1|hev1|hvcC/.test(all);
    const avc = /avc1|avcC/.test(all);
    const aac = /mp4a/.test(all);
    const looksMp4 = /ftyp/.test(head);
    let action = 'ready';
    let title = '已适合上传';
    let risk = '';
    if (!looksMp4) {
      action = 'transcode';
      title = '转码为 H.264 + AAC';
      risk = '当前不像常见 MP4，苹果/微信可能播不了，开播也可能很慢';
    } else if (hevc && !avc) {
      action = 'transcode';
      title = '转成 H.264（现在是 H.265）';
      risk = 'H.265 在苹果和微信网页里经常播不了';
    } else if (avc && !aac) {
      action = 'audio';
      title = '只转音轨为 AAC';
      risk = '苹果/微信里可能没有声音';
    } else if (avc && aac && !faststart) {
      action = 'faststart';
      title = '加上 faststart';
      risk = '开播会很慢（索引在文件尾，往往要先下载大半个文件）';
    } else if (!avc) {
      action = 'transcode';
      title = '转码为 H.264 + AAC';
      risk = '编码不确定，学员设备可能播不了或开播很慢';
    } else if (!faststart) {
      action = 'faststart';
      title = '加上 faststart';
      risk = '开播可能较慢';
    }
    return { action, title, risk, faststart };
  }

  function confirmVideoAdvice(report) {
    return new Promise((resolve) => {
      const prev = document.getElementById('ops-video-advice');
      if (prev) prev.remove();
      const box = document.createElement('div');
      box.id = 'ops-video-advice';
      box.className = 'ops-modal';
      box.innerHTML = `
        <div class="ops-modal__card" role="dialog" aria-labelledby="ops-video-advice-title">
          <h3 id="ops-video-advice-title">建议先用净土视频工作台处理</h3>
          <p>检查结果：建议<strong>${escapeHtml(report.title)}</strong>后再上传，以免${escapeHtml(report.risk)}。</p>
          <p>请先下载 Windows 工具，在电脑上转好，再上传处理好的文件。若执意上传原文件，仍可以继续。</p>
          <div class="ops-modal__actions">
            <a class="btn btn--solid" style="color:#fbf6e6;" href="/api/download?path=media/jingtu-video-helper.zip">下载净土视频工作台</a>
            <button type="button" class="btn" data-act="upload" style="color:inherit;border-color:var(--line);">仍要上传</button>
            <button type="button" class="btn" data-act="cancel" style="color:inherit;border-color:var(--line);">取消</button>
          </div>
        </div>`;
      const finish = (v) => {
        box.remove();
        resolve(v);
      };
      box.addEventListener('click', (e) => {
        if (e.target === box) finish('cancel');
        const act = e.target?.getAttribute?.('data-act');
        if (act === 'upload' || act === 'cancel') finish(act);
      });
      document.body.appendChild(box);
    });
  }

  function probeVideoHeight(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      const done = (h) => {
        URL.revokeObjectURL(url);
        resolve(h || 0);
      };
      v.onloadedmetadata = () => done(v.videoHeight);
      v.onerror = () => done(0);
      setTimeout(() => done(0), 8000);
      v.src = url;
    });
  }

  function bindUpload(kind, mod, les) {
    const input = $(`upload-${kind}`);
    if (!input) return;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const isVideo = kind === 'video' || kind === 'video-sd';
      if (isVideo) {
        try {
          const report = await inspectVideoFile(file);
          if (report.action !== 'ready') {
            const choice = await confirmVideoAdvice(report);
            if (choice !== 'upload') {
              input.value = '';
              return;
            }
          }
        } catch (e) {
          const ok = confirm(
            `无法自动检查该视频（${e.message || e}）。\n建议先用「净土视频工作台」处理后再传。\n仍要直接上传吗？`,
          );
          if (!ok) {
            input.value = '';
            return;
          }
        }
      }

      if (kind === 'video-sd' && !(les.videoPath && String(les.videoPath).trim())) {
        alert('请先上传高清（若片子已经是 480p，请传到「高清」口，只保留一档）。');
        input.value = '';
        return;
      }

      let field = 'audioPath';
      let keyStem = `${mod.slug}/${les.slug}`;
      let label = '音频';
      let clearSd = false;
      if (kind === 'video') {
        field = 'videoPath';
        label = '高清视频';
        const height = await probeVideoHeight(file);
        const alreadySd = height > 0 && height <= 480;
        const hadSd = !!(les.videoPathSd && String(les.videoPathSd).trim());
        const replacing = !!(les.videoPath && String(les.videoPath).trim());
        if (replacing && hadSd) {
          const ok = confirm(
            alreadySd
              ? '将替换高清路径，并清空旧标清（新片已是 480p，只保留一档）。是否继续？'
              : '将替换高清路径，并清空旧标清，避免学员默认仍播旧标清。是否继续？',
          );
          if (!ok) {
            input.value = '';
            return;
          }
        }
        if (alreadySd || replacing) clearSd = true;
        if (alreadySd) {
          showMsg(saveMsg, `检测到约 ${height}p，将只保留一档（写入高清路径，不另建标清）。`, true);
        }
      } else if (kind === 'video-sd') {
        field = 'videoPathSd';
        keyStem = `${mod.slug}/${les.slug}-sd`;
        label = '标清视频';
      }

      const ext = isVideo ? 'mp4' : mediaExt(file, 'mp3');
      const key = versionedKey(keyStem, ext);
      les[field] = key;
      if (clearSd) les.videoPathSd = '';

      try {
        setUploadUi(kind, {
          pct: 0,
          text: `准备上传：${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`,
        });
        showMsg(saveMsg, `正在上传${label}…`, true);
        await uploadFile(key, file, (done, total) => {
          const pct = Math.min(100, Math.round((done / total) * 100));
          setUploadUi(kind, {
            pct,
            text: `上传中 ${pct}% · ${file.name}`,
          });
        });
        setUploadUi(kind, {
          pct: 100,
          text: `上传完成：${key}`,
          ok: true,
        });
        showMsg(saveMsg, '上传完成，正在自动保存目录…', true);
        await saveCatalog({ reason: `上传成功并已自动保存：${key}` });
        renderEditor();
        setUploadUi(kind, {
          pct: null,
          text: `上传完成并已保存：${key}`,
          ok: true,
        });
      } catch (e) {
        const msg = String(e.message || e);
        setUploadUi(kind, { pct: null, text: msg, error: true });
        showMsg(saveMsg, msg, false);
      } finally {
        input.value = '';
      }
    });
  }

  $('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: fd.get('password') }),
      });
      await ensureSession();
    } catch (err) {
      showMsg($('login-msg'), err.message, false);
    }
  });

  $('logout-btn')?.addEventListener('click', async () => {
    if (anyDirty() && !confirm('有未保存修改，确定退出？')) return;
    await api('/api/logout', { method: 'POST' });
    await ensureSession();
  });

  $('btn-reload')?.addEventListener('click', () => {
    if (sideMode === 'articles') {
      if (articlesDirty && !confirm('好文有未保存修改，重新加载将丢失。继续？')) return;
      loadArticles().catch((e) => showMsg(saveMsg, e.message, false));
      return;
    }
    if (dirty && !confirm('有未保存修改，重新加载将丢失。继续？')) return;
    loadCatalog().catch((e) => showMsg(saveMsg, e.message, false));
  });

  $('btn-save')?.addEventListener('click', () => {
    if (sideMode === 'articles') {
      saveArticles().catch(() => {});
      return;
    }
    saveCatalog().catch(() => {});
  });

  $('btn-passages-warm')?.addEventListener('click', () => {
    warmPassagesBatch().catch(() => {});
  });
  $('btn-passages-refresh')?.addEventListener('click', () => {
    refreshPassagesStatus().catch(() => {});
  });
  $('btn-passages-toggle')?.addEventListener('click', () => {
    const body = $('passages-body');
    const btn = $('btn-passages-toggle');
    const hint = btn?.querySelector('.ops-cards-toggle__hint');
    if (!body || !btn) return;
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (hint) hint.textContent = open ? '收起' : '展开';
  });

  // workspace 相关的 tab 切换（仅在 ops-app.js 未处理时作为备用）
  // 主要切换逻辑在 index.astro 的内联脚本中处理
  document.querySelectorAll('.ops-tab[data-group="workspace"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.tab || 'module';
      switchWorkspace(mode);
    });
  });

  // 暴露到全局，供 index.astro 的 tab 切换逻辑调用
  window.switchWorkspace = switchWorkspace;

  $('btn-add-module')?.addEventListener('click', () => {
    if (!catalog) {
      showMsg(saveMsg, '请先登录并加载目录', false);
      return;
    }
    if (sideMode !== 'module') {
      sideMode = 'module';
    }
    addModule();
    collapsedNavGroups.delete('其他');
    renderModuleList();
    updateWorkspaceChrome();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!anyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  ensureSession();
})();
