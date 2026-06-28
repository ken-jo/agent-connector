export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  category: "BUILDING";
  readingMinutes: number;
  heroImage: {
    src: string;
    alt: string;
    caption: string;
  };
  sections: {
    heading: string;
    body: string[];
  }[];
}

export const blogPosts: BlogPost[] = [
  {
    slug: "building",
    title: "BUILDING...",
    description:
      "A temporary test post while the blog surface, routing, RSS feed, and image rendering are being checked.",
    date: "2026-06-29",
    category: "BUILDING",
    readingMinutes: 1,
    heroImage: {
      src: "/blog/building-cover.svg",
      alt: "Abstract construction card for the agent-connector blog test post",
      caption: "Temporary cover image used to verify blog image rendering.",
    },
    sections: [
      {
        heading: "Why this exists",
        body: [
          "The blog is intentionally not publishing polished articles yet. This single post keeps the route, detail page, RSS feed, and image layout visible while the editorial direction is still being shaped.",
          "Real posts can be added once the content model, image treatment, and audience fit are reviewed in the browser.",
        ],
      },
      {
        heading: "What to check",
        body: [
          "Confirm the blog index shows one post, the post detail shows this image with a stable aspect ratio, `/feed.xml` contains the same post, and future article drafts do not appear as public content too early.",
        ],
      },
    ],
  },
];

export const blogPostBySlug: Record<string, BlogPost> = Object.fromEntries(
  blogPosts.map((post) => [post.slug, post]),
);
