/* jx-catalog v20260726i — stairs without step nums, larger chapter text */
window.JX = window.JX || {};

JX.r2Base = () =>
  document.querySelector('meta[name="r2-base"]')?.content?.replace(/\/$/, '') || '';

JX.assetUrl = (path) => {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) return path;
  const base = JX.r2Base();
  if (!base) return '';
  return `${base}/${path.replace(/^\//, '')}`;
};

/** 模块列表页（可配置 slug，不再写死 /lunhui/ 等） */
JX.moduleHref = (slug) => `/mod/?id=${encodeURIComponent(slug || '')}`;

/** 课学习页 */
JX.lessonHref = (modSlug, lessonSlug) =>
  `/mod/learn/?mod=${encodeURIComponent(modSlug || '')}&id=${encodeURIComponent(lessonSlug || '')}`;

/** 强制另存为（同源 API，避免音视频在浏览器内直接播放） */
JX.downloadHref = (path) => {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) {
    try {
      const u = new URL(path);
      const base = JX.r2Base();
      if (base && path.startsWith(base + '/')) {
        return `/api/download?path=${encodeURIComponent(path.slice(base.length + 1))}`;
      }
    } catch (_) {}
    return path;
  }
  return `/api/download?path=${encodeURIComponent(String(path).replace(/^\//, ''))}`;
};

JX.fetchCatalog = async () => {
  const res = await fetch('/api/catalog');
  if (!res.ok) throw new Error('无法加载课程目录');
  return res.json();
};

JX.lessonCount = (mod) =>
  (mod.chapters || []).reduce((n, ch) => n + (ch.lessons?.length || 0), 0);

/** 首页/学修：分区写死，条目按 slug 取模块 */
JX.HOME_SECTIONS = [
  {
    title: '净土学修',
    slugs: ['nianfo', 'jingdian', 'xiuxing'],
  },
];

/** @deprecated 书籍/材料已归「参考资料」，不再挂在学修目录 */
JX.HOME_BOOKS = [];

JX.modBySlug = (catalog, slug) =>
  (catalog?.modules || []).find((m) => m.slug === slug) || null;

/** 旧版：按 slug 写死分区（无 section 字段时回退） */
JX.legacySlugPlacement = () => {
  if (JX._legacyPlacement) return JX._legacyPlacement;
  const map = Object.create(null);
  for (const sec of JX.HOME_SECTIONS || []) {
    for (const slug of sec.slugs || []) {
      map[slug] = { section: sec.title, group: '' };
    }
    for (const g of sec.groups || []) {
      for (const slug of g.slugs || []) {
        map[slug] = { section: sec.title, group: g.title || '' };
      }
    }
  }
  JX._legacyPlacement = map;
  return map;
};

/**
 * 解析模块所属分区。
 * - section 为「未归类」：明确未归类
 * - section 有值：用运营配置
 * - 否则回退旧 slug 名单
 */
JX.resolveModSection = (mod) => {
  if (!mod) return { section: '', group: '' };
  const raw = mod.section;
  if (raw === '未归类') return { section: '', group: '' };
  const sec = String(raw ?? '').trim();
  if (sec) {
    return { section: sec, group: String(mod.sectionGroup || '').trim() };
  }
  const legacy = JX.legacySlugPlacement()[mod.slug];
  if (legacy) return { section: legacy.section, group: legacy.group || '' };
  return { section: '', group: '' };
};

JX.modulesInSection = (catalog, sectionTitle, groupTitle) => {
  const wantGroup = groupTitle == null ? null : String(groupTitle);
  return (catalog?.modules || []).filter((m) => {
    const p = JX.resolveModSection(m);
    if (p.section !== sectionTitle) return false;
    if (wantGroup == null) return true;
    return (p.group || '') === wantGroup;
  });
};

JX.unsectionedModules = (catalog) =>
  (catalog?.modules || []).filter((m) => !JX.resolveModSection(m).section);

JX.refByIdOrTitle = (catalog, id, title) => {
  const refs = catalog?.references || [];
  return (
    refs.find((r) => r.id === id) ||
    refs.find((r) => (r.title || '') === title) ||
    null
  );
};

JX.renderBookRow = (catalog, item) => {
  const title = typeof item === 'string' ? item : item.title;
  const id = typeof item === 'string' ? '' : item.id || '';
  const ref = JX.refByIdOrTitle(catalog, id, title);
  const fileUrl = ref?.path ? JX.assetUrl(ref.path) : '';
  const href = fileUrl || (ref?.id ? `/reference/books/#${encodeURIComponent(ref.id)}` : '/reference/books/');
  const meta = fileUrl ? '打开 PDF' : '进入参考资料';
  const external = fileUrl
    ? ' target="_blank" rel="noopener"'
    : '';
  const hint = fileUrl
    ? `<p class="book-list__hint">文件可能较大，打开或下载需要一些时间，请稍候。</p>`
    : '';
  return `
    <li>
      <a class="book-list__link" href="${href}"${external}>
        <span class="book-list__title">《${JX.escape(title)}》</span>
        <span class="book-list__meta">${meta}</span>
      </a>
      ${hint}
    </li>`;
};

JX.renderModuleRow = (mod, index) => {
  if (!mod) {
    return `
      <li class="is-missing">
        <span class="module-list__num">${String(index + 1).padStart(2, '0')}</span>
        <div>
          <p class="module-list__meta">待创建</p>
          <h3 class="module-list__title">（模块缺失）</h3>
        </div>
      </li>`;
  }
  const count = JX.lessonCount(mod);
  const open = mod.status === 'open';
  const meta = `${JX.escape(mod.statusLabel || (open ? '开放中' : '即将开放'))}${count ? ` · ${count} 课` : ''}`;
  return `
    <li class="${open ? 'is-open' : ''}">
      <a href="${JX.moduleHref(mod.slug)}">
        <span class="module-list__num">${String(index + 1).padStart(2, '0')}</span>
        <div>
          <p class="module-list__meta">${meta}</p>
          <h3 class="module-list__title">《${JX.escape(mod.title)}》</h3>
          ${mod.summary ? `<p class="module-list__summary">${JX.escape(mod.summary)}</p>` : ''}
        </div>
      </a>
    </li>`;
};

JX.renderSlugList = (catalog, slugs) =>
  `<ul class="module-list">${(slugs || [])
    .map((slug, i) => JX.renderModuleRow(JX.modBySlug(catalog, slug), i))
    .join('')}</ul>`;

JX.renderModList = (mods) =>
  `<ul class="module-list">${(mods || [])
    .map((mod, i) => JX.renderModuleRow(mod, i))
    .join('')}</ul>`;

/** 首页次第：基础课→实修篇 竖长台阶 */
JX.HOME_STAIR_TITLES = ['基础课', '公共学修', '专业课', '实修篇'];

JX.renderStairModFromMod = (mod) => {
  if (!mod) {
    return `<li class="path-stairs__mod is-missing"><span>（缺失）</span></li>`;
  }
  const open = mod.status === 'open';
  return `
    <li class="path-stairs__mod ${open ? 'is-open' : 'is-soon'}">
      <a href="${JX.moduleHref(mod.slug)}">${JX.escape(mod.title)}</a>
    </li>`;
};

JX.renderSectionModsBody = (catalog, sec) => {
  if (sec.groups?.length) {
    const knownGroups = new Set(sec.groups.map((g) => g.title));
    const groupBlocks = sec.groups
      .map((g) => {
        const mods = JX.modulesInSection(catalog, sec.title, g.title);
        if (!mods.length) return '';
        return `
          <div class="home-group">
            <h3 class="home-group__title">${JX.escape(g.title)}</h3>
            ${JX.renderModList(mods)}
          </div>`;
      })
      .join('');
    const orphans = JX.modulesInSection(catalog, sec.title).filter(
      (m) => !knownGroups.has(JX.resolveModSection(m).group),
    );
    const orphanBlock = orphans.length
      ? `<div class="home-group"><h3 class="home-group__title">其他</h3>${JX.renderModList(orphans)}</div>`
      : '';
    return groupBlocks + orphanBlock;
  }
  return JX.renderModList(JX.modulesInSection(catalog, sec.title, ''));
};

JX.renderHomeStairs = (catalog) => {
  const pathSecs = (JX.HOME_SECTIONS || []).filter((s) =>
    (JX.HOME_STAIR_TITLES || []).includes(s.title)
  );
  const items = pathSecs
    .map((sec) => {
      let modsHtml = '';
      let anyOpen = false;
      if (sec.groups?.length) {
        const knownGroups = new Set(sec.groups.map((g) => g.title));
        const groupLis = sec.groups
          .map((g) => {
            const mods = JX.modulesInSection(catalog, sec.title, g.title);
            if (!mods.length) return '';
            if (mods.some((m) => m.status === 'open')) anyOpen = true;
            return `
            <li class="path-stairs__group">
              <span class="path-stairs__group-title">${JX.escape(g.title)}</span>
              <ul class="path-stairs__mods">
                ${mods.map((m) => JX.renderStairModFromMod(m)).join('')}
              </ul>
            </li>`;
          })
          .join('');
        const orphans = JX.modulesInSection(catalog, sec.title).filter(
          (m) => !knownGroups.has(JX.resolveModSection(m).group),
        );
        if (orphans.some((m) => m.status === 'open')) anyOpen = true;
        const orphanLis = orphans.length
          ? `<li class="path-stairs__group">
              <span class="path-stairs__group-title">其他</span>
              <ul class="path-stairs__mods">${orphans.map((m) => JX.renderStairModFromMod(m)).join('')}</ul>
            </li>`
          : '';
        modsHtml = `<ul class="path-stairs__groups">${groupLis}${orphanLis}</ul>`;
      } else {
        const mods = JX.modulesInSection(catalog, sec.title, '');
        anyOpen = mods.some((m) => m.status === 'open');
        modsHtml = `<ul class="path-stairs__mods">${mods.map((m) => JX.renderStairModFromMod(m)).join('')}</ul>`;
      }
      return `
        <li class="path-stairs__item ${anyOpen ? 'is-open' : 'is-soon'}">
          <div class="path-stairs__card">
            <span class="path-stairs__sec">${JX.escape(sec.title)}</span>
            ${modsHtml}
          </div>
          <span class="path-stairs__arrow" aria-hidden="true">→</span>
        </li>`;
    })
    .join('');

  return `
    <section class="home-block home-block--stairs">
      <div class="section__head">
        <h2>次第修学</h2>
        <p>建议按下列次第，一门接一门循序学修。</p>
      </div>
      <ol class="path-stairs path-stairs--sections">
        ${items}
        ${JX.renderPathMore()}
      </ol>
    </section>`;
};

JX.renderHomeSections = (catalog, opts = {}) => {
  const mode = opts.mode || 'list';
  const stairTitles = new Set(JX.HOME_STAIR_TITLES || []);

  let main = '';
  if (mode === 'stairs') {
    main = JX.renderHomeStairs(catalog);
  }

  const listSecs = (JX.HOME_SECTIONS || []).filter((sec) => {
    if (mode === 'stairs' && stairTitles.has(sec.title)) return false;
    return true;
  });

  const parts = listSecs.map((sec) => {
    const body = JX.renderSectionModsBody(catalog, sec);
    if (!String(body).includes('module-list__title') && !String(body).includes('module-list')) {
      // still render empty section? skip empty
    }
    if (!body || body === '<ul class="module-list"></ul>') return '';
    return `
      <section class="home-block">
        <div class="section__head">
          <h2>${JX.escape(sec.title)}</h2>
        </div>
        ${body}
      </section>`;
  }).filter(Boolean);

  const extras = JX.unsectionedModules(catalog);
  if (extras.length) {
    parts.push(`
      <section class="home-block">
        <div class="section__head">
          <h2>未归类</h2>
          <p>尚未选择学修分区的模块，可在运营后台为模块指定分区。</p>
        </div>
        ${JX.renderModList(extras)}
      </section>`);
  }

  // 书籍与其他材料不在学修目录展示，见 /reference/
  return main + parts.join('');
};

/** 兼容旧调用 */
JX.pathModules = (catalog) => catalog?.modules || [];
JX.extraModules = () => [];
JX.renderPathItem = (mod, index) => JX.renderModuleRow(mod, index);
JX.renderPathListItem = (mod, index) => JX.renderModuleRow(mod, index);
JX.renderPathMore = () => `
  <li class="path-stairs__more" aria-label="后续还有更多次第">
    <span class="path-stairs__more-dots" aria-hidden="true">···</span>
    <span class="path-stairs__more-title">后续</span>
    <span class="path-stairs__more-label">还有更多</span>
  </li>`;

JX.formatLessonMeta = (lesson) => {
  const texts = lesson.text?.trim() ? 1 : 0;
  const audios = lesson.audioPath?.trim() ? 1 : 0;
  const videos = lesson.videoPath?.trim() ? 1 : 0;
  return `文 ${texts} · 音 ${audios} · 视 ${videos}`;
};

JX.escape = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 科判标题：甲一、… / 丙二、略说： / 乙一：…
 * 天干 + 中文数字 + （顿号或冒号）+ 标题。
 * 不认：全论分三：一、…；以及「甲一（…）分二：一、…」概述句。
 */
JX.HEADING_RE = /^[甲乙丙丁戊己庚辛壬癸][一二三四五六七八九十百]+[、：:].+$/;

JX.inlineFormat = (escaped) =>
  escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

JX.isOutlineHeading = (line) => {
  const s = String(line || '').trim();
  if (!JX.HEADING_RE.test(s)) return false;
  // 「甲一（礼赞…）分二：一、…；二、…」这类总述不算目录标题
  if (/分[一二三四五六七八九十]+[：:]/.test(s)) return false;
  if (/[；;]/.test(s)) return false;
  if (/（/.test(s) && /）/.test(s) && /分/.test(s)) return false;
  return true;
};

/**
 * 解析课文：按行识别科判标题；每一非空行自成一段（段间空一行）。
 * @returns {{ html: string, toc: { id: string, title: string }[] }}
 */
JX.parseArticle = (text) => {
  const toc = [];
  const raw = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!raw) return { html: '', toc };

  const lines = raw.split('\n');
  let headingIdx = 0;
  const parts = [];

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;

    if (JX.isOutlineHeading(line)) {
      const id = `sec-${headingIdx++}`;
      toc.push({ id, title: line });
      parts.push(
        `<h2 class="learn-heading" id="${id}">${JX.inlineFormat(JX.escape(line))}</h2>`,
      );
    } else {
      parts.push(`<p>${JX.inlineFormat(JX.escape(line))}</p>`);
    }
  }

  return { html: parts.join(''), toc };
};

JX.formatText = (text) => JX.parseArticle(text).html;

JX.findLesson = (catalog, moduleSlug, lessonSlug) => {
  const mod = catalog.modules.find((m) => m.slug === moduleSlug);
  if (!mod) return null;
  for (const ch of mod.chapters || []) {
    const les = (ch.lessons || []).find((l) => l.slug === lessonSlug);
    if (les) {
      return { mod, chapter: ch, lesson: les, lessonsFlat: JX.flatLessons(mod) };
    }
  }
  return null;
};

JX.flatLessons = (mod) => {
  const list = [];
  for (const ch of mod.chapters || []) {
    for (const les of ch.lessons || []) list.push({ ...les, chapterTitle: ch.title });
  }
  return list;
};
