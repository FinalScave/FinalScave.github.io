import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { SITE_DESCRIPTION, SITE_TITLE, getExcerpt, postUrl, sortPosts } from '../lib/posts';

export async function GET(context) {
  const posts = sortPosts(await getCollection('posts'));
  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description ?? getExcerpt(post.body),
      pubDate: post.data.date,
      link: postUrl(post),
    })),
  });
}
