import type { Env } from './auth';

export const CARDS_KEY = 'config/retrieval-cards.json';
export const CARD_QUEUE_KEY = 'config/card-queue.json';
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export type RetrievalCard = {
  version: number;
  lessonId: string;
  moduleSlug: string;
  moduleTitle: string;
  chapterTitle: string;
  lessonSlug: string;
  title: string;
  summary: string;
  topics: string[];
  terms: { term: string; gloss: string }[];
  outline: string[];
  canAnswer: string[];
  notCover: string[];
  keyClaims: string[];
  quotes: string[];
  entities: string[];
  aliases: string[];
  sections: {
    heading: string;
    focus: string;
    keywords: string[];
    canAnswer: string[];
  }[];
  sourceHash: string;
  updatedAt: string;
};

export type CardStore = {
  version: number;
  updatedAt: string;
  cards: Record<string, RetrievalCard>;
};

export type QueueItem = {
  lessonId: string;
  moduleSlug: string;
  lessonSlug: string;
  sourceHash: string;
  /** offpeak = 仅空闲时段；asap = 立即 */
  priority: 'offpeak' | 'asap';
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
};

export type CardQueue = {
  version: number;
  updatedAt: string;
  items: QueueItem[];
};

export type LessonRef = {
  lessonId: string;
  moduleSlug: string;
  moduleTitle: string;
  chapterTitle: string;
  lessonSlug: string;
  lessonTitle: string;
  text: string;
  sourceHash: string;
};

/** 北京时间：12:00–14:00，以及 18:00–次日 09:00 */
export function isOffPeakChina(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
  );
  if (hour >= 12 && hour < 14) return true;
  if (hour >= 18 || hour < 9) return true;
  return false;
}

export function chinaTimeLabel(now = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

export async function sha256Short(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

export function lessonIdOf(moduleSlug: string, lessonSlug: string): string {
  return `${moduleSlug}/${lessonSlug}`;
}

export function extractLessonsFromCatalog(catalog: any): LessonRef[] {
  const rows: LessonRef[] = [];
  for (const mod of catalog?.modules || []) {
    for (const ch of mod.chapters || []) {
      for (const les of ch.lessons || []) {
        let text = typeof les.text === 'string' ? les.text : '';
        if (!text.trim() && Array.isArray(les.segments)) {
          text = les.segments
            .map((s: any) => String(s?.text || '').trim())
            .filter(Boolean)
            .join('\n\n');
        }
        text = text.trim();
        if (!text) continue;
        const moduleSlug = String(mod.slug || '');
        const lessonSlug = String(les.slug || '');
        if (!moduleSlug || !lessonSlug) continue;
        rows.push({
          lessonId: lessonIdOf(moduleSlug, lessonSlug),
          moduleSlug,
          moduleTitle: mod.title || moduleSlug,
          chapterTitle: ch.title || '',
          lessonSlug,
          lessonTitle: les.title || lessonSlug,
          text,
          sourceHash: '', // filled async by caller if needed
        });
      }
    }
  }
  return rows;
}

export async function withHashes(lessons: LessonRef[]): Promise<LessonRef[]> {
  return Promise.all(
    lessons.map(async (l) => ({
      ...l,
      sourceHash: await sha256Short(l.text),
    })),
  );
}

export async function loadCardStore(env: Env): Promise<CardStore> {
  if (!env.FILES) return { version: 1, updatedAt: '', cards: {} };
  const obj = await env.FILES.get(CARDS_KEY);
  if (!obj) return { version: 1, updatedAt: '', cards: {} };
  const raw: any = await obj.json();
  return {
    version: Number(raw?.version) || 1,
    updatedAt: String(raw?.updatedAt || ''),
    cards: raw?.cards && typeof raw.cards === 'object' ? raw.cards : {},
  };
}

export async function saveCardStore(env: Env, store: CardStore): Promise<void> {
  store.updatedAt = new Date().toISOString();
  store.version = 1;
  await env.FILES.put(CARDS_KEY, JSON.stringify(store), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

export async function loadQueue(env: Env): Promise<CardQueue> {
  if (!env.FILES) return { version: 1, updatedAt: '', items: [] };
  const obj = await env.FILES.get(CARD_QUEUE_KEY);
  if (!obj) return { version: 1, updatedAt: '', items: [] };
  const raw: any = await obj.json();
  return {
    version: Number(raw?.version) || 1,
    updatedAt: String(raw?.updatedAt || ''),
    items: Array.isArray(raw?.items) ? raw.items : [],
  };
}

export async function saveQueue(env: Env, queue: CardQueue): Promise<void> {
  queue.updatedAt = new Date().toISOString();
  queue.version = 1;
  await env.FILES.put(CARD_QUEUE_KEY, JSON.stringify(queue), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

/** 将课加入队列；已在队列则更新 hash/priority */
export function enqueueLessons(
  queue: CardQueue,
  lessons: LessonRef[],
  priority: 'offpeak' | 'asap' = 'offpeak',
): number {
  const map = new Map(queue.items.map((it) => [it.lessonId, it]));
  let n = 0;
  const now = new Date().toISOString();
  for (const l of lessons) {
    const prev = map.get(l.lessonId);
    if (prev) {
      prev.sourceHash = l.sourceHash;
      if (priority === 'asap') prev.priority = 'asap';
      prev.lastError = undefined;
      n++;
    } else {
      map.set(l.lessonId, {
        lessonId: l.lessonId,
        moduleSlug: l.moduleSlug,
        lessonSlug: l.lessonSlug,
        sourceHash: l.sourceHash,
        priority,
        enqueuedAt: now,
        attempts: 0,
      });
      n++;
    }
  }
  queue.items = [...map.values()];
  return n;
}

export function cardStatusForLesson(
  lesson: LessonRef,
  store: CardStore,
  queue: CardQueue,
): 'ready' | 'queued' | 'stale' | 'missing' | 'failed' {
  const card = store.cards[lesson.lessonId];
  const q = queue.items.find((i) => i.lessonId === lesson.lessonId);
  if (card && card.sourceHash === lesson.sourceHash) return 'ready';
  if (q && q.attempts >= 5 && q.lastError) return 'failed';
  if (q) return 'queued';
  if (card) return 'stale';
  return 'missing';
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return m ? m[1].trim() : t;
}

function asStringArray(v: unknown, max = 40): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeCard(raw: any, lesson: LessonRef, sourceHash: string): RetrievalCard {
  const termsIn = Array.isArray(raw?.terms) ? raw.terms : [];
  const terms = termsIn
    .map((t: any) => {
      if (typeof t === 'string') return { term: t.trim(), gloss: '' };
      return {
        term: String(t?.term || '').trim(),
        gloss: String(t?.gloss || '').trim(),
      };
    })
    .filter((t: { term: string }) => t.term)
    .slice(0, 40);

  const sectionsIn = Array.isArray(raw?.sections) ? raw.sections : [];
  const sections = sectionsIn
    .map((s: any) => ({
      heading: String(s?.heading || '').trim(),
      focus: String(s?.focus || '').trim(),
      keywords: asStringArray(s?.keywords, 12),
      canAnswer: asStringArray(s?.canAnswer, 8),
    }))
    .filter((s: { heading: string; focus: string }) => s.heading || s.focus)
    .slice(0, 30);

  return {
    version: 1,
    lessonId: lesson.lessonId,
    moduleSlug: lesson.moduleSlug,
    moduleTitle: lesson.moduleTitle,
    chapterTitle: lesson.chapterTitle,
    lessonSlug: lesson.lessonSlug,
    title: lesson.lessonTitle,
    summary: String(raw?.summary || '').trim(),
    topics: asStringArray(raw?.topics, 24),
    terms,
    outline: asStringArray(raw?.outline, 40),
    canAnswer: asStringArray(raw?.canAnswer, 30),
    notCover: asStringArray(raw?.notCover, 16),
    keyClaims: asStringArray(raw?.keyClaims, 20),
    quotes: asStringArray(raw?.quotes, 20),
    entities: asStringArray(raw?.entities, 30),
    aliases: asStringArray(raw?.aliases, 24),
    sections,
    sourceHash,
    updatedAt: new Date().toISOString(),
  };
}

const GEN_SYSTEM = `你是「慧灯净土」的文献索引助手。请根据给定课文全文，生成一张「检索卡」JSON，供日后语义检索选题使用。
要求：
1. 只能依据原文，不得编造原文没有的名相、教证、人物或观点。
2. 内容尽量充分、利于检索：摘要写够细节；主题、可答问题、原句摘录、分段要点都要丰富。
3. 严格输出一个 JSON 对象，不要 Markdown，不要代码围栏，不要解释。
4. JSON 字段：
- summary: string（6～10句提要）
- topics: string[]（12～20个主题/近义说法）
- terms: {term, gloss}[]（名相+极短释义）
- outline: string[]（科判/小标题，尽量全）
- canAnswer: string[]（15～25条本课能回答的问题）
- notCover: string[]（本课基本不涉及的内容）
- keyClaims: string[]（8～15条核心命题短句）
- quotes: string[]（8～15条原文关键句，尽量原词）
- entities: string[]（人物/经论/譬喻/数目表等）
- aliases: string[]（学员可能使用的口语/别称）
- sections: {heading, focus, keywords[], canAnswer[]}[]（按科判或自然段拆分）`;

export async function generateCardWithDeepSeek(
  apiKey: string,
  lesson: LessonRef,
): Promise<RetrievalCard> {
  const userMsg = `模块：${lesson.moduleTitle}
章节：${lesson.chapterTitle}
课名：${lesson.lessonTitle}
课ID：${lesson.lessonId}

课文全文：
${lesson.text}`;

  const aiRes = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: GEN_SYSTEM },
        { role: 'user', content: userMsg },
      ],
      // flash 非思考模式更稳、更省
      thinking: { type: 'disabled' },
    }),
  });

  const aiData: any = await aiRes.json().catch(() => ({}));
  if (!aiRes.ok) {
    const msg = aiData?.error?.message || aiData?.message || `DeepSeek 错误 ${aiRes.status}`;
    throw new Error(msg);
  }
  const content = String(aiData?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('模型未返回检索卡');

  let parsed: any;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    throw new Error('检索卡 JSON 解析失败');
  }

  const hash = lesson.sourceHash || (await sha256Short(lesson.text));
  return normalizeCard(parsed, lesson, hash);
}

/** 选题用的紧凑文本（厚但可控） */
export function cardToIndexText(card: RetrievalCard): string {
  const termLine = (card.terms || [])
    .map((t) => (t.gloss ? `${t.term}（${t.gloss}）` : t.term))
    .join('、');
  const secLine = (card.sections || [])
    .slice(0, 12)
    .map((s) => `${s.heading || '段'}：${s.focus}`)
    .join('；');
  return [
    `【${card.lessonId}】${card.moduleTitle} · ${card.title}`,
    `提要：${card.summary}`,
    `主题：${(card.topics || []).join('、')}`,
    `名相：${termLine}`,
    `可答：${(card.canAnswer || []).slice(0, 18).join('；')}`,
    `不含：${(card.notCover || []).join('；')}`,
    `命题：${(card.keyClaims || []).slice(0, 12).join('；')}`,
    `别称：${(card.aliases || []).join('、')}`,
    `原句：${(card.quotes || []).slice(0, 10).join('｜')}`,
    `实体：${(card.entities || []).join('、')}`,
    `分段：${secLine}`,
  ]
    .filter((line) => !line.endsWith('：') && !line.endsWith('· '))
    .join('\n');
}

/** 用检索卡字段（及可选正文）对问题做本地粗排 */
export function scoreCardAgainstQuestion(
  card: RetrievalCard,
  question: string,
  fullText?: string,
): number {
  const q = String(question || '').toLowerCase().replace(/\s+/g, '');
  const qChars = new Set([...q].filter((c) => /[\u4e00-\u9fff]/.test(c)));
  const bigrams = new Set<string>();
  for (let i = 0; i < q.length - 1; i++) {
    const a = q[i];
    const b = q[i + 1];
    if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) bigrams.add(a + b);
  }

  const bags: { text: string; w: number }[] = [
    { text: (card.canAnswer || []).join('\n'), w: 5 },
    { text: (card.topics || []).join('\n'), w: 4 },
    { text: (card.aliases || []).join('\n'), w: 4 },
    { text: (card.terms || []).map((t) => `${t.term} ${t.gloss}`).join('\n'), w: 3 },
    { text: (card.keyClaims || []).join('\n'), w: 3 },
    { text: (card.quotes || []).join('\n'), w: 3 },
    { text: (card.entities || []).join('\n'), w: 2 },
    { text: card.summary || '', w: 2 },
    { text: `${card.title}\n${card.moduleTitle}`, w: 2 },
    {
      text: (card.sections || [])
        .map((s) => `${s.heading}\n${s.focus}\n${(s.keywords || []).join(' ')}\n${(s.canAnswer || []).join(' ')}`)
        .join('\n'),
      w: 3,
    },
  ];

  let score = 0;
  for (const bag of bags) {
    const t = bag.text.toLowerCase();
    if (!t) continue;
    let hit = 0;
    for (const bg of bigrams) {
      if (t.includes(bg)) hit += 2;
    }
    for (const ch of qChars) {
      if (t.includes(ch)) hit += 0.15;
    }
    // 整句/整词问题出现在可答、主题等字段
    if (bag.w >= 4 && q.length >= 2 && t.includes(q)) hit += 20;
    score += hit * bag.w;
  }

  // 正文原词命中：强加权（解决卡字段未写全、但课里大段在讲的情况）
  if (fullText && q.length >= 2) {
    const ft = fullText;
    if (ft.includes(q)) {
      score += 150;
      let occ = 0;
      let pos = 0;
      while ((pos = ft.indexOf(q, pos)) >= 0 && occ < 8) {
        occ++;
        pos += q.length;
      }
      score += occ * 30;
    }
  }

  // notCover 命中则降权
  const notCover = (card.notCover || []).join('\n').toLowerCase();
  if (notCover) {
    let penalty = 0;
    for (const bg of bigrams) {
      if (notCover.includes(bg)) penalty += 1;
    }
    score -= penalty * 3;
  }

  return score;
}

/** 在正文中定位问题相关段落，尽量扩到 excerptMax（不返回卡摘要冒充原文） */
export function pickExcerptsFromCard(
  fullText: string,
  card: RetrievalCard | undefined,
  question: string,
  max = 1,
  excerptMax = 500,
): string[] {
  const text = String(fullText || '');
  if (!text.trim()) return [];

  const q = String(question || '').replace(/\s+/g, '').trim();

  const snapTrim = (s: string) => {
    let t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length > excerptMax) {
      const cut = t.slice(0, excerptMax);
      const stop = Math.max(
        cut.lastIndexOf('。'),
        cut.lastIndexOf('！'),
        cut.lastIndexOf('？'),
        cut.lastIndexOf('；'),
        cut.lastIndexOf('\n'),
      );
      t = (stop > excerptMax * 0.35 ? cut.slice(0, stop + 1) : cut.trim()) + (stop > excerptMax * 0.35 ? '' : '…');
    }
    return t;
  };

  /** 以锚点为中心向两边扩到约 excerptMax，并尽量落在句号边界 */
  const expandAround = (idx: number, needleLen = 2): string => {
    if (idx < 0) return '';
    const target = Math.max(120, excerptMax);
    let start = idx;
    let end = Math.min(text.length, idx + Math.max(needleLen, 8));

    // 先尽量向前找到段落/句首
    const backLimit = Math.max(0, idx - Math.floor(target * 0.35));
    for (let i = idx - 1; i >= backLimit; i--) {
      start = i;
      if (text[i] === '\n' || text[i] === '。' || text[i] === '！' || text[i] === '？') {
        start = i + 1;
        break;
      }
    }

    end = Math.min(text.length, start + target);
    // 向后落到句号
    if (end < text.length) {
      const slice = text.slice(start, Math.min(text.length, start + target + 80));
      const stop = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'));
      if (stop > target * 0.4) end = start + stop + 1;
    }

    // 若仍偏短且后面还有字，再补一点
    if (end - start < Math.min(target, text.length) && end < text.length) {
      end = Math.min(text.length, start + target);
    }

    return snapTrim(text.slice(start, end));
  };

  const scoreAt = (idx: number) => {
    if (idx < 0) return -1;
    // 越靠前略加分；完整问词命中额外加分
    let s = 1000 - Math.min(idx, 900);
    if (q.length >= 2 && text.slice(idx, idx + q.length) === q) s += 500;
    return s;
  };

  const candidates: { idx: number; len: number; score: number }[] = [];

  // 1) 正文整词/整句命中（最优先）
  if (q.length >= 2) {
    let pos = 0;
    while ((pos = text.indexOf(q, pos)) >= 0) {
      candidates.push({ idx: pos, len: q.length, score: scoreAt(pos) + 2000 });
      pos += q.length;
      if (candidates.length > 12) break;
    }
  }

  // 2) 问题里较长的中文片段（≥2）
  const parts = String(question || '').match(/[\u4e00-\u9fff]{2,}/g) || [];
  const uniqParts = [...new Set(parts)].sort((a, b) => b.length - a.length);
  for (const p of uniqParts.slice(0, 6)) {
    let pos = 0;
    let n = 0;
    while ((pos = text.indexOf(p, pos)) >= 0 && n < 4) {
      candidates.push({ idx: pos, len: p.length, score: scoreAt(pos) + p.length * 10 });
      pos += p.length;
      n++;
    }
  }

  // 3) 卡内 quotes 只作「定位针」，不直接当原文展示
  for (const qot of card?.quotes || []) {
    const needle = String(qot || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (needle.length < 4) continue;
    const idx = text.indexOf(needle);
    if (idx >= 0) {
      const bonus = q && String(qot).includes(q) ? 800 : 0;
      candidates.push({ idx, len: needle.length, score: scoreAt(idx) + 200 + bonus });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= max) break;
    const ex = expandAround(c.idx, c.len);
    if (!ex) continue;
    if (out.some((x) => x.slice(0, 32) === ex.slice(0, 32))) continue;
    out.push(ex);
  }

  // 4) 再退：滑窗找命中最多的 excerptMax 窗口（仍取正文）
  if (!out.length) {
    const win = Math.min(excerptMax, 500);
    const qBigrams: string[] = [];
    for (let i = 0; i < q.length - 1; i++) {
      if (/[\u4e00-\u9fff]/.test(q[i]) && /[\u4e00-\u9fff]/.test(q[i + 1])) qBigrams.push(q.slice(i, i + 2));
    }
    let best = { score: -1, slice: '' };
    const step = Math.max(80, Math.floor(win / 3));
    for (let i = 0; i < text.length; i += step) {
      const slice = text.slice(i, i + win);
      let hit = 0;
      for (const bg of qBigrams) if (slice.includes(bg)) hit += 2;
      if (q.length >= 2 && slice.includes(q)) hit += 50;
      if (hit > best.score) best = { score: hit, slice };
      if (i + win >= text.length) break;
    }
    if (best.score > 0) out.push(snapTrim(best.slice));
  }

  return out;
}

export async function processQueueOnce(
  env: Env,
  catalog: any,
  opts: { force?: boolean; limit?: number } = {},
): Promise<{
  processed: number;
  skippedOffPeak: boolean;
  results: { lessonId: string; ok: boolean; error?: string }[];
  queueLeft: number;
  offPeak: boolean;
}> {
  const force = !!opts.force;
  const limit = Math.max(1, Math.min(opts.limit ?? 2, 5));
  const offPeak = isOffPeakChina();

  if (!force && !offPeak) {
    const queue = await loadQueue(env);
    return {
      processed: 0,
      skippedOffPeak: true,
      results: [],
      queueLeft: queue.items.length,
      offPeak,
    };
  }

  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('未配置 DEEPSEEK_API_KEY');
  }

  const lessons = await withHashes(extractLessonsFromCatalog(catalog));
  const byId = new Map(lessons.map((l) => [l.lessonId, l]));
  const queue = await loadQueue(env);
  const store = await loadCardStore(env);

  // asap 优先，再按入队时间
  const sorted = queue.items.slice().sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === 'asap' ? -1 : 1;
    return a.enqueuedAt.localeCompare(b.enqueuedAt);
  });

  const runnable = force
    ? sorted
    : sorted.filter((it) => it.priority === 'asap' || offPeak);

  const results: { lessonId: string; ok: boolean; error?: string }[] = [];
  let processed = 0;

  for (const item of runnable) {
    if (processed >= limit) break;
    const lesson = byId.get(item.lessonId);
    if (!lesson) {
      queue.items = queue.items.filter((x) => x.lessonId !== item.lessonId);
      results.push({ lessonId: item.lessonId, ok: false, error: '课已不存在，已移出队列' });
      continue;
    }

    try {
      const card = await generateCardWithDeepSeek(env.DEEPSEEK_API_KEY, {
        ...lesson,
        sourceHash: item.sourceHash || lesson.sourceHash,
      });
      store.cards[card.lessonId] = card;
      queue.items = queue.items.filter((x) => x.lessonId !== item.lessonId);
      results.push({ lessonId: item.lessonId, ok: true });
      processed++;
    } catch (e) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = String(e);
      results.push({ lessonId: item.lessonId, ok: false, error: String(e) });
      processed++;
      // 失败也计一次，避免死循环占满窗口
    }
  }

  await saveCardStore(env, store);
  await saveQueue(env, queue);

  return {
    processed,
    skippedOffPeak: false,
    results,
    queueLeft: queue.items.length,
    offPeak,
  };
}
