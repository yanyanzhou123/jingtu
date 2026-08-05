import seed from '../content/catalog.seed.json';

export type Lesson = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  text: string;
  audioPath: string;
  videoPath: string;
};

export type Chapter = {
  id: string;
  title: string;
  lessons: Lesson[];
};

export type ReferenceItem = {
  id: string;
  title: string;
  meta?: string;
  path: string;
};

export type LearningModule = {
  id: string;
  slug: string;
  title: string;
  shortTitle: string;
  summary: string;
  status: 'open' | 'coming';
  statusLabel: string;
  intro: string;
  /** @deprecated 参考资料已提升为目录顶层 references */
  references?: ReferenceItem[];
  chapters: Chapter[];
  href?: string;
  lessonCount?: number;
};

export type Catalog = {
  version: number;
  references: ReferenceItem[];
  modules: LearningModule[];
};

export const seedCatalog = seed as Catalog;

export function lessonCount(mod: LearningModule) {
  return (mod.chapters || []).reduce((n, ch) => n + (ch.lessons?.length || 0), 0);
}

export function formatLessonMeta(lesson: Lesson) {
  const texts = lesson.text?.trim() ? 1 : 0;
  const audios = lesson.audioPath?.trim() ? 1 : 0;
  const videos = lesson.videoPath?.trim() ? 1 : 0;
  return `文 ${texts} · 音 ${audios} · 视 ${videos}`;
}

export const modules = seedCatalog.modules.map((m) => ({
  ...m,
  href: `/mod/?id=${encodeURIComponent(m.slug)}`,
  lessonCount: lessonCount(m),
}));

export function getModule(slug: string) {
  return modules.find((m) => m.slug === slug);
}
