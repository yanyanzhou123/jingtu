import type { Env } from './auth';
import { extractLessonsFromCatalog, sha256Short, withHashes, type LessonRef } from './cards';

export const PASSAGES_KEY = 'config/passages.json';
export const EMBED_MODEL = '@cf/baai/bge-m3';

export type Passage = {
  id: string;
  lessonId: string;
  moduleSlug: string;
  moduleTitle: string;
  chapterTitle: string;
  lessonSlug: string;
  lessonTitle: string;
  text: string;
  sourceHash: string;
  idx: number;
};

export type PassageStore = {
  version: number;
  updatedAt: string;
  /** lessonId → 当前正文 hash */
  lessonHashes: Record<string, string>;
  passages: Record<string, Passage>;
};

const CHUNK_TARGET = 560;
const CHUNK_OVERLAP = 80;
const EMBED_BATCH = 8;
const VECTOR_TOP_K = 20;
const KEYWORD_TOP_K = 20;
const RRF_K = 60;
/** 向量最高分过低则视为无可靠语义命中 */
export const MIN_VECTOR_SCORE = 0.52;
/** 关键词需达到此分（整词命中约 100）才算强相关 */
const MIN_KEYWORD_SCORE = 35;
export const FINAL_TOP_PASSAGES = 4;

export function emptyPassageStore(): PassageStore {
  return { version: 1, updatedAt: '', lessonHashes: {}, passages: {} };
}

export async function loadPassageStore(env: Env): Promise<PassageStore> {
  if (!env.FILES) return emptyPassageStore();
  const obj = await env.FILES.get(PASSAGES_KEY);
  if (!obj) return emptyPassageStore();
  try {
    const raw = (await obj.json()) as PassageStore;
    return {
      version: raw.version || 1,
      updatedAt: raw.updatedAt || '',
      lessonHashes: raw.lessonHashes || {},
      passages: raw.passages || {},
    };
  } catch {
    return emptyPassageStore();
  }
}

export async function savePassageStore(env: Env, store: PassageStore): Promise<void> {
  if (!env.FILES) return;
  store.updatedAt = new Date().toISOString();
  await env.FILES.put(PASSAGES_KEY, JSON.stringify(store), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

/** 按科判标题 / 空行切段，再合并到约 CHUNK_TARGET 字 */
export function chunkLessonText(raw: string): string[] {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const headingRe =
    /(?:^|\n)\s*((?:[甲乙丙丁戊己庚辛壬癸][一二三四五六七八九十百千]+[、.．:：]|第[一二三四五六七八九十百千\d]+[课章节段、.．:：]|[（(][一二三四五六七八九十\d]+[）)]))/;

  const rough: string[] = [];
  const parts = text.split(/\n{2,}/);
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    if (p.length <= CHUNK_TARGET * 1.35) {
      rough.push(p);
      continue;
    }
    // 再按科判标题切
    const idxs: number[] = [0];
    const re = new RegExp(headingRe.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(p))) {
      if (m.index > 0) idxs.push(m.index);
    }
    idxs.push(p.length);
    for (let i = 0; i < idxs.length - 1; i++) {
      const slice = p.slice(idxs[i], idxs[i + 1]).trim();
      if (slice) rough.push(slice);
    }
  }

  const out: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (const block of rough) {
    if (!buf) {
      buf = block;
    } else if (buf.length + block.length + 1 <= CHUNK_TARGET * 1.2) {
      buf = `${buf}\n${block}`;
    } else {
      flush();
      buf = block;
    }
    while (buf.length > CHUNK_TARGET * 1.5) {
      let cut = buf.lastIndexOf('。', CHUNK_TARGET);
      if (cut < CHUNK_TARGET * 0.4) cut = buf.lastIndexOf('\n', CHUNK_TARGET);
      if (cut < CHUNK_TARGET * 0.4) cut = CHUNK_TARGET;
      out.push(buf.slice(0, cut + 1).trim());
      const rest = buf.slice(Math.max(0, cut + 1 - CHUNK_OVERLAP)).trim();
      buf = rest;
    }
  }
  flush();
  return out.filter(Boolean);
}

async function passageIdFor(lessonId: string, idx: number, chunk: string): Promise<string> {
  const h = await sha256Short(`${lessonId}|${idx}|${chunk.slice(0, 64)}`);
  return `p${h}`; // 33 chars, Vectorize-safe
}

export async function buildPassagesForLesson(lesson: LessonRef): Promise<Passage[]> {
  const chunks = chunkLessonText(lesson.text);
  const rows: Passage[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    const id = await passageIdFor(lesson.lessonId, i, text);
    rows.push({
      id,
      lessonId: lesson.lessonId,
      moduleSlug: lesson.moduleSlug,
      moduleTitle: lesson.moduleTitle,
      chapterTitle: lesson.chapterTitle,
      lessonSlug: lesson.lessonSlug,
      lessonTitle: lesson.lessonTitle,
      text,
      sourceHash: lesson.sourceHash,
      idx: i,
    });
  }
  return rows;
}

type AiEmbedOut = { data?: number[][] };

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (!env.AI) throw new Error('未绑定 Workers AI（AI）');
  if (!texts.length) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = (await env.AI.run(EMBED_MODEL, { text: batch })) as AiEmbedOut;
    const data = res?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error('Embedding 返回数量与输入不一致');
    }
    for (const row of data) {
      if (!Array.isArray(row) || !row.length) throw new Error('Embedding 向量为空');
      out.push(row);
    }
  }
  return out;
}

function hasVectorize(env: Env): boolean {
  return !!(env.AI && env.VECTORIZE && env.FILES);
}

export function hybridReady(env: Env, store?: PassageStore): boolean {
  if (!hasVectorize(env)) return false;
  if (store) return Object.keys(store.passages).length > 0;
  return true;
}

/** 增量重建：处理 hash 变更或缺失的课，每次最多 limit 课 */
export async function processPassageRebuild(
  env: Env,
  catalog: any,
  opts: { limit?: number; forceAll?: boolean; lessonIds?: string[] } = {},
): Promise<{
  processed: number;
  upserted: number;
  deleted: number;
  left: number;
  totalPassages: number;
  error?: string;
}> {
  if (!hasVectorize(env)) {
    return {
      processed: 0,
      upserted: 0,
      deleted: 0,
      left: 0,
      totalPassages: 0,
      error: '未绑定 AI / VECTORIZE / FILES',
    };
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 6, 20));
  const lessons = await withHashes(extractLessonsFromCatalog(catalog));
  const store = await loadPassageStore(env);

  let targets = lessons;
  if (opts.lessonIds?.length) {
    const set = new Set(opts.lessonIds);
    targets = lessons.filter((l) => set.has(l.lessonId));
  } else if (!opts.forceAll) {
    targets = lessons.filter((l) => store.lessonHashes[l.lessonId] !== l.sourceHash);
  }

  const batch = targets.slice(0, limit);
  let upserted = 0;
  let deleted = 0;

  for (const lesson of batch) {
    const oldIds = Object.values(store.passages)
      .filter((p) => p.lessonId === lesson.lessonId)
      .map((p) => p.id);
    if (oldIds.length) {
      try {
        await env.VECTORIZE!.deleteByIds(oldIds);
        deleted += oldIds.length;
      } catch {
        // 索引中不存在时忽略
      }
      for (const id of oldIds) delete store.passages[id];
    }

    const passages = await buildPassagesForLesson(lesson);
    if (!passages.length) {
      store.lessonHashes[lesson.lessonId] = lesson.sourceHash;
      continue;
    }

    const vectors = await embedTexts(
      env,
      passages.map((p) => p.text),
    );

    const payload = passages.map((p, i) => ({
      id: p.id,
      values: vectors[i],
      metadata: {
        lessonId: p.lessonId,
        moduleSlug: p.moduleSlug,
        lessonSlug: p.lessonSlug,
        moduleTitle: p.moduleTitle.slice(0, 80),
        lessonTitle: p.lessonTitle.slice(0, 80),
      },
    }));

    // Vectorize upsert 建议分批
    for (let i = 0; i < payload.length; i += 50) {
      await env.VECTORIZE!.upsert(payload.slice(i, i + 50));
    }

    for (const p of passages) store.passages[p.id] = p;
    store.lessonHashes[lesson.lessonId] = lesson.sourceHash;
    upserted += passages.length;
  }

  // 清理已删除课的段落
  const live = new Set(lessons.map((l) => l.lessonId));
  const orphanIds = Object.values(store.passages)
    .filter((p) => !live.has(p.lessonId))
    .map((p) => p.id);
  if (orphanIds.length) {
    try {
      await env.VECTORIZE!.deleteByIds(orphanIds);
      deleted += orphanIds.length;
    } catch {
      // ignore
    }
    for (const id of orphanIds) delete store.passages[id];
    for (const lid of Object.keys(store.lessonHashes)) {
      if (!live.has(lid)) delete store.lessonHashes[lid];
    }
  }

  await savePassageStore(env, store);
  const left = Math.max(0, targets.length - batch.length);

  return {
    processed: batch.length,
    upserted,
    deleted,
    left,
    totalPassages: Object.keys(store.passages).length,
  };
}

function tokenizeQuestion(q: string): string[] {
  const raw = String(q || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9]+/g, ' ');
  const parts = raw.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) || [];
  const tokens: string[] = [];
  for (const p of parts) {
    if (/[\u4e00-\u9fff]/.test(p)) {
      if (p.length >= 2) tokens.push(p);
      for (let i = 0; i < p.length - 1; i++) tokens.push(p.slice(i, i + 2));
      if (p.length >= 3) {
        for (let i = 0; i < p.length - 2; i++) tokens.push(p.slice(i, i + 3));
      }
    } else if (p.length > 1) {
      tokens.push(p);
    }
  }
  return [...new Set(tokens)];
}

export function keywordRankPassages(
  passages: Passage[],
  question: string,
  topK = KEYWORD_TOP_K,
): { id: string; score: number }[] {
  const q = String(question || '').replace(/\s+/g, '');
  const toks = tokenizeQuestion(question).filter((t) => t.length >= 3);
  if (!q && !toks.length) return [];

  const scored = passages.map((p) => {
    let score = 0;
    if (q.length >= 2 && p.text.includes(q)) {
      score += 100;
      score += Math.min(8, p.text.split(q).length - 1) * 20;
    }
    for (const t of toks) {
      if (p.text.includes(t)) score += t.length >= 4 ? 6 : 3;
    }
    if (q.length >= 2 && (p.lessonTitle.includes(q) || p.moduleTitle.includes(q))) score += 40;
    return { id: p.id, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function rrfFuse(rankLists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankLists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

export type HybridHit = Passage & { score: number; vectorScore?: number; keywordScore?: number };

/**
 * 混合检索：向量 + 关键词 → RRF
 */
export async function hybridRetrieve(
  env: Env,
  question: string,
  opts: { preferModule?: string; topN?: number } = {},
): Promise<{ hits: HybridHit[]; meta: Record<string, unknown> }> {
  const store = await loadPassageStore(env);
  const all = Object.values(store.passages);
  if (!all.length) {
    return { hits: [], meta: { reason: 'empty-index', passages: 0 } };
  }
  if (!env.AI || !env.VECTORIZE) {
    return { hits: [], meta: { reason: 'missing-bindings' } };
  }

  const topN = opts.topN ?? FINAL_TOP_PASSAGES;
  const qNorm = String(question || '').trim();
  if (!qNorm) return { hits: [], meta: { reason: 'empty-question' } };

  // 1) 向量召回
  const [qVec] = await embedTexts(env, [qNorm]);
  const vecRes = await env.VECTORIZE.query(qVec, {
    topK: VECTOR_TOP_K,
    returnMetadata: 'none',
  });
  const vecMatches = vecRes?.matches || [];
  const topVec = vecMatches[0]?.score ?? 0;
  const vecIds = vecMatches.map((m) => m.id);
  const vecScoreMap = new Map(vecMatches.map((m) => [m.id, m.score ?? 0]));

  // 2) 关键词召回
  const kw = keywordRankPassages(all, qNorm, KEYWORD_TOP_K);
  const kwIds = kw.map((x) => x.id);
  const kwScoreMap = new Map(kw.map((x) => [x.id, x.score]));

  // 若向量很弱且关键词也不强 → 无结果（避免无关问题硬塞来源）
  const bestKw = kw[0]?.score || 0;
  const hasStrongKw = bestKw >= MIN_KEYWORD_SCORE;
  const vecStrong = topVec >= MIN_VECTOR_SCORE;
  if (!vecStrong && !hasStrongKw) {
    return {
      hits: [],
      meta: {
        selection: 'hybrid-vector',
        topVectorScore: topVec,
        keywordHits: kwIds.length,
        bestKeywordScore: bestKw,
        reason: 'below-threshold',
      },
    };
  }

  const lists: string[][] = [];
  if (vecStrong) lists.push(vecIds);
  if (hasStrongKw) lists.push(kwIds);
  if (!lists.length) {
    return {
      hits: [],
      meta: {
        selection: 'hybrid-vector',
        topVectorScore: topVec,
        reason: 'below-threshold',
      },
    };
  }

  const fused = rrfFuse(lists);

  // 当前模块轻微加权
  if (opts.preferModule) {
    for (const [id, s] of fused) {
      const p = store.passages[id];
      if (p?.moduleSlug === opts.preferModule) fused.set(id, s * 1.08);
    }
  }

  const ranked = [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => store.passages[id]);

  // 按课去重：每课保留最好的一段；单段落须向量或关键词够强
  const seenLesson = new Set<string>();
  const hits: HybridHit[] = [];
  for (const id of ranked) {
    const p = store.passages[id];
    if (!p) continue;
    if (seenLesson.has(p.lessonId)) continue;
    const ks = kwScoreMap.get(id) || 0;
    const vs = vecScoreMap.get(id) || 0;
    if (vs < MIN_VECTOR_SCORE && ks < MIN_KEYWORD_SCORE) continue;
    seenLesson.add(p.lessonId);
    hits.push({
      ...p,
      score: fused.get(id) || 0,
      vectorScore: vs,
      keywordScore: ks,
    });
    if (hits.length >= topN) break;
  }

  if (!hits.length) {
    return {
      hits: [],
      meta: {
        selection: 'hybrid-vector',
        topVectorScore: topVec,
        keywordHits: kwIds.length,
        bestKeywordScore: bestKw,
        reason: 'below-threshold',
        passages: all.length,
      },
    };
  }

  return {
    hits,
    meta: {
      selection: 'hybrid-vector',
      topVectorScore: topVec,
      vectorHits: vecIds.length,
      keywordHits: kwIds.length,
      bestKeywordScore: bestKw,
      passages: all.length,
      returned: hits.length,
    },
  };
}

export function passageStatus(env: Env, store: PassageStore, lessons: LessonRef[]) {
  let ready = 0;
  let stale = 0;
  let missing = 0;
  for (const l of lessons) {
    const h = store.lessonHashes[l.lessonId];
    if (!h) missing++;
    else if (h !== l.sourceHash) stale++;
    else ready++;
  }
  return {
    ready,
    stale,
    missing,
    passages: Object.keys(store.passages).length,
    bindings: { ai: !!env.AI, vectorize: !!env.VECTORIZE },
  };
}
