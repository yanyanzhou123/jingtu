import { type Env, json } from '../_lib/auth';
import {
  DEEPSEEK_MODEL,
  DEEPSEEK_URL,
  extractLessonsFromCatalog,
  isOffPeakChina,
  pickExcerptsFromCard,
} from '../_lib/cards';
import {
  hybridReady,
  hybridRetrieve,
  loadPassageStore,
  processPassageRebuild,
} from '../_lib/passages';

const CATALOG_KEY = 'config/catalog.json';
const RATE_PER_MIN = 8;
const MAX_QUESTION_LEN = 500;
const SOFT_MAX_SOURCES = 3;
const EXCERPT_MAX = 500;
const SOURCE_LABELS = ['来源一', '来源二', '来源三', '来源四', '来源五', '来源六'];

type LessonRow = {
  lessonId: string;
  moduleSlug: string;
  moduleTitle: string;
  chapterTitle: string;
  lessonSlug: string;
  lessonTitle: string;
  text: string;
};

type SourceBlock = {
  label: string;
  moduleSlug: string;
  moduleTitle: string;
  chapterTitle: string;
  lessonSlug: string;
  lessonTitle: string;
  href: string;
  excerpts: string[];
};

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function allowRequest(request: Request): Promise<boolean> {
  try {
    const ip = clientIp(request);
    const bucket = Math.floor(Date.now() / 60000);
    const key = new Request(`https://jx-ask-rate.internal/${ip}/${bucket}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    const count = hit ? Number(await hit.text()) || 0 : 0;
    if (count >= RATE_PER_MIN) return false;
    await cache.put(
      key,
      new Response(String(count + 1), {
        headers: { 'Cache-Control': 'max-age=120' },
      }),
    );
    return true;
  } catch {
    return true;
  }
}

function tokenize(s: string): string[] {
  const raw = String(s || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9]+/g, ' ');
  const parts = raw.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) || [];
  const tokens: string[] = [];
  for (const p of parts) {
    if (/[\u4e00-\u9fff]/.test(p)) {
      for (let i = 0; i < p.length; i++) tokens.push(p[i]);
      for (let i = 0; i < p.length - 1; i++) tokens.push(p.slice(i, i + 2));
      if (p.length >= 3) {
        for (let i = 0; i < p.length - 2; i++) tokens.push(p.slice(i, i + 3));
      }
    } else if (p.length > 1) {
      tokens.push(p);
    }
  }
  return tokens;
}

function trimExcerpt(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= EXCERPT_MAX) return t;
  return `${t.slice(0, EXCERPT_MAX).trim()}…（节选）`;
}

function pickExcerptsKeyword(text: string, question: string, max = 2): string[] {
  const chunks: string[] = [];
  const step = Math.max(400, EXCERPT_MAX - 100);
  const win = EXCERPT_MAX;
  for (let i = 0; i < text.length; i += Math.max(120, Math.floor(win / 3))) {
    chunks.push(text.slice(i, Math.min(i + win, text.length)));
    if (i + win >= text.length) break;
  }
  const qSet = new Set(tokenize(question));
  const scored = chunks
    .map((c) => {
      const toks = tokenize(c);
      let hit = 0;
      const seen = new Set<string>();
      for (const t of toks) {
        if (qSet.has(t) && !seen.has(t)) {
          seen.add(t);
          hit += t.length >= 2 ? 2 : 1;
        }
      }
      return { c, hit };
    })
    .sort((a, b) => b.hit - a.hit);
  const out: string[] = [];
  for (const s of scored) {
    if (out.length >= max) break;
    if (s.hit <= 0 && out.length > 0) continue;
    out.push(trimExcerpt(s.c));
  }
  if (!out.length && text.trim()) out.push(trimExcerpt(text));
  return out;
}

async function loadCatalog(env: Env, request: Request): Promise<any> {
  if (env.FILES) {
    const obj = await env.FILES.get(CATALOG_KEY);
    if (obj) return obj.json();
  }
  const origin = new URL(request.url).origin;
  const res = await fetch(`${origin}/catalog.seed.json`);
  if (!res.ok) throw new Error('无法加载学修目录');
  return res.json();
}

async function deepseekChat(
  apiKey: string,
  system: string,
  user: string,
  temperature = 0.2,
  jsonMode = false,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: DEEPSEEK_MODEL,
    temperature,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const aiRes = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const aiData: any = await aiRes.json().catch(() => ({}));
  if (!aiRes.ok) {
    const msg = aiData?.error?.message || aiData?.message || `DeepSeek 错误 ${aiRes.status}`;
    throw new Error(msg);
  }
  const content = String(aiData?.choices?.[0]?.message?.content || '').trim();
  if (!content) throw new Error('模型未返回内容');
  return content;
}

function keywordFallback(lessons: LessonRow[], question: string, preferModule?: string): string[] {
  const qSet = new Set(tokenize(question));
  if (!qSet.size) return [];
  const scored = lessons
    .map((l) => {
      const toks = tokenize(`${l.lessonTitle}\n${l.chapterTitle}\n${l.text.slice(0, 2000)}`);
      let hit = 0;
      const seen = new Set<string>();
      for (const t of toks) {
        if (qSet.has(t) && !seen.has(t)) {
          seen.add(t);
          hit += t.length >= 2 ? 2 : 1;
        }
      }
      if (preferModule && l.moduleSlug === preferModule) hit *= 1.35;
      return { id: l.lessonId, score: hit };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const best = scored[0];
  const second = scored[1]?.score || 0;
  if (best.score < 6) return [];
  if (second > 0 && best.score < second * 1.25 && best.score < 12) return [];
  return [best.id];
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!(await allowRequest(request))) {
    return json({ error: '提问过于频繁，请稍后再试。' }, 429);
  }
  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: '未配置 DeepSeek API Key' }, 500);
  }

  try {
    if (env.FILES && env.AI && env.VECTORIZE) {
      context.waitUntil(
        loadPassageStore(env)
          .then(async (ps) => {
            if (!hybridReady(env, ps) || isOffPeakChina()) {
              return processPassageRebuild(env, await loadCatalog(env, request), { limit: 3 });
            }
            return null;
          })
          .catch(() => null),
      );
    }
  } catch {
    // ignore
  }

  let body: { question?: string; moduleSlug?: string; lessonSlug?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求格式错误' }, 400);
  }

  const question = String(body.question || '').trim();
  if (!question) return json({ error: '请输入问题' }, 400);
  if (question.length > MAX_QUESTION_LEN) {
    return json({ error: `问题请控制在 ${MAX_QUESTION_LEN} 字以内` }, 400);
  }

  let catalog: any;
  try {
    catalog = await loadCatalog(env, request);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

  const prefer = String(body.moduleSlug || '').trim();
  const lessons: LessonRow[] = extractLessonsFromCatalog(catalog).map((l) => ({
    lessonId: l.lessonId,
    moduleSlug: l.moduleSlug,
    moduleTitle: l.moduleTitle,
    chapterTitle: l.chapterTitle,
    lessonSlug: l.lessonSlug,
    lessonTitle: l.lessonTitle,
    text: l.text,
  }));
  const byId = new Map(lessons.map((l) => [l.lessonId, l]));

  let sources: SourceBlock[] = [];
  let selection: 'hybrid-vector' | 'keyword-fallback' = 'keyword-fallback';
  let retrieveMeta: Record<string, unknown> = {};

  // —— 主路径：向量 + 关键词混合检索 ——
  try {
    const pStore = await loadPassageStore(env);
    if (hybridReady(env, pStore)) {
      const { hits, meta } = await hybridRetrieve(env, question, {
        preferModule: prefer || undefined,
        topN: SOFT_MAX_SOURCES,
      });
      retrieveMeta = meta;
      if (hits.length) {
        selection = 'hybrid-vector';
        sources = hits.map((h, i) => {
          const lesson = byId.get(h.lessonId);
          let excerpts = pickExcerptsFromCard(
            lesson?.text || h.text,
            undefined,
            question,
            1,
            EXCERPT_MAX,
          );
          if (!excerpts.length) excerpts = [trimExcerpt(h.text)];
          excerpts = excerpts.map((ex) => trimExcerpt(ex)).slice(0, 1);
          return {
            label: SOURCE_LABELS[i] || `来源${i + 1}`,
            moduleSlug: h.moduleSlug,
            moduleTitle: h.moduleTitle,
            chapterTitle: h.chapterTitle,
            lessonSlug: h.lessonSlug,
            lessonTitle: h.lessonTitle,
            href: `/mod/learn/?mod=${encodeURIComponent(h.moduleSlug)}&id=${encodeURIComponent(h.lessonSlug)}`,
            excerpts,
          };
        });
      }
    }
  } catch (e) {
    retrieveMeta = { hybridError: String(e) };
  }

  // —— 回退：关键词（检索卡已停用）——
  if (!sources.length) {
    const selectedIds = keywordFallback(lessons, question, prefer || undefined);
    selection = 'keyword-fallback';
    const selected = selectedIds.map((id) => byId.get(id)).filter(Boolean) as LessonRow[];
    sources = selected.map((l, i) => {
      let excerpts = pickExcerptsKeyword(l.text, question, 1).slice(0, 1);
      if (!excerpts.length) excerpts = [trimExcerpt(l.text)];
      excerpts = excerpts.map((ex) => trimExcerpt(ex)).slice(0, 1);
      return {
        label: SOURCE_LABELS[i] || `来源${i + 1}`,
        moduleSlug: l.moduleSlug,
        moduleTitle: l.moduleTitle,
        chapterTitle: l.chapterTitle,
        lessonSlug: l.lessonSlug,
        lessonTitle: l.lessonTitle,
        href: `/mod/learn/?mod=${encodeURIComponent(l.moduleSlug)}&id=${encodeURIComponent(l.lessonSlug)}`,
        excerpts,
      };
    });
  }

  if (!sources.length) {
    return json({
      ok: true,
      passages: [],
      sources: [],
      summary:
        '已录入的学修文稿中，未能找到与该问题明显相关的内容。建议换个问法，或直接到对应课程中阅读原文。',
      meta: { selection, ...retrieveMeta },
    });
  }

  const passages = sources.map((s) => ({ label: s.label, excerpts: s.excerpts }));

  const contextBlocks = sources
    .map((s) => {
      const bodyText = s.excerpts
        .map((ex, i) => (s.excerpts.length > 1 ? `（段${i + 1}）${ex}` : ex))
        .join('\n');
      return `${s.label}\n课程：${s.moduleTitle} · ${s.lessonTitle}\n原文：\n${bodyText}`;
    })
    .join('\n\n');

  const system = `你是「慧灯净土」网站的学修助手。页面已向学员展示相关原文与出处链接。
你的任务：仅依据用户消息中的原文，写一段简短归纳，帮助学员把握要点。
规则：
1. 只能依据给出的原文归纳；原文未述及的内容，写「已录入文稿中未述及」，不要编造。
2. 使用简洁、恭敬、明白的中文。可用「1. 2. 3.」分点，但不要使用 Markdown（不要用 **、#、-、[]() 等符号）。
3. 不要写「出处」「来源一」「文稿」等编号引用；出处由页面单独展示。
4. 不要重复大段原文，只做归纳。
5. 你不能替代依止上师与如理闻思，仅作辅助。`;

  let summary = '';
  try {
    summary = await deepseekChat(
      env.DEEPSEEK_API_KEY,
      system,
      `学员问题：${question}\n\n已检索到的原文：\n${contextBlocks}`,
    );
    summary = summary.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  } catch (e) {
    return json({ error: `调用模型失败：${String(e)}` }, 502);
  }

  return json({
    ok: true,
    passages,
    sources: sources.map((s) => ({
      label: s.label,
      moduleSlug: s.moduleSlug,
      moduleTitle: s.moduleTitle,
      chapterTitle: s.chapterTitle,
      lessonSlug: s.lessonSlug,
      lessonTitle: s.lessonTitle,
      href: s.href,
    })),
    summary,
    meta: {
      selection,
      ...retrieveMeta,
    },
  });
};
