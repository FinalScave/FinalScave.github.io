import type { CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'posts'>;

export const SITE_TITLE = "Scave's Blog";
export const SITE_DESCRIPTION =
  "Scave's personal technology blog mainly records his usual learning summary, problem solving and other related contents.";

export function sortPosts(posts: BlogPost[]) {
  return [...posts].sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function postUrl(post: BlogPost) {
  return `/${trimSlashes(post.data.path)}/`;
}

export function tagUrl(tag: string) {
  return `/tags/${encodeURIComponent(tag)}/`;
}

export function archiveYearUrl(year: string) {
  return `/archives/${year}/`;
}

export function archiveMonthUrl(year: string, month: string) {
  return `/archives/${year}/${month}/`;
}

export function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, '');
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getAllTags(posts: BlogPost[]) {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

export function groupByYear(posts: BlogPost[]) {
  const groups = new Map<string, BlogPost[]>();
  for (const post of posts) {
    const year = String(post.data.date.getFullYear());
    groups.set(year, [...(groups.get(year) ?? []), post]);
  }
  return [...groups.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
}

export function groupByMonth(posts: BlogPost[]) {
  const groups = new Map<string, BlogPost[]>();
  for (const post of posts) {
    const year = String(post.data.date.getFullYear());
    const month = String(post.data.date.getMonth() + 1).padStart(2, '0');
    const key = `${year}/${month}`;
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

export function getExcerpt(body: string, size = 140) {
  const text = body
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > size ? `${text.slice(0, size)}...` : text;
}
