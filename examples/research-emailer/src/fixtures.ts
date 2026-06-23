/**
 * A tiny deterministic "web": search + read return fixed content for any topic,
 * so the demo never touches the network and is fully reproducible. These are the
 * read-only tools; they may safely re-execute live during a fork.
 */

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface Document {
  url: string;
  title: string;
  content: string;
}

const FACETS = ['introduction', 'applications', 'risks'] as const;

export function slugify(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'topic';
}

export function searchCorpus(query: string): SearchResult[] {
  const slug = slugify(query);
  return FACETS.map((facet) => ({
    url: `https://example.org/${slug}/${facet}`,
    title: `${query}: ${cap(facet)}`,
    snippet: `A short overview of the ${facet} of ${query}.`,
  }));
}

export function readCorpus(url: string): Document {
  const parts = url.split('/');
  const facet = parts[parts.length - 1] ?? 'introduction';
  const slug = parts[parts.length - 2] ?? 'topic';
  const topic = slug.replace(/-/g, ' ');
  return {
    url,
    title: `${cap(topic)}: ${cap(facet)}`,
    content: facetContent(topic, facet),
  };
}

function facetContent(topic: string, facet: string): string {
  switch (facet) {
    case 'introduction':
      return `${cap(topic)} is an area of active study. It combines several ideas into a coherent whole.`;
    case 'applications':
      return `${cap(topic)} is applied across industry and research. Common uses include automation and analysis.`;
    case 'risks':
      return `${cap(topic)} carries real risks. Practitioners weigh reliability, cost, and unintended effects.`;
    default:
      return `${cap(topic)} has many facets worth understanding.`;
  }
}

function cap(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
