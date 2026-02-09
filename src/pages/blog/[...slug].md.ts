import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  return posts.map((post) => ({
    params: { slug: post.slug },
    props: { post },
  }));
};

export const GET: APIRoute = ({ props }) => {
  const { post } = props;
  const markdown = `# ${post.data.title}\n\n${post.data.description}\n\n${post.body}`;
  return new Response(markdown, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
