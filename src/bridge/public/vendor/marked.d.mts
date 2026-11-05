// Types for the slice of marked's lexer the terminal preview walks (src/preview/render.ts).
// The browser imports marked.mjs untyped; only TypeScript reads this file.
export interface Token {
  type: string;
  raw: string;
  text?: string;
  tokens?: Token[];
  depth?: number;
  lang?: string;
  ordered?: boolean;
  start?: number | "";
  items?: Token[];
  task?: boolean;
  checked?: boolean;
  header?: Array<{ text: string; tokens: Token[] }>;
  rows?: Array<Array<{ text: string; tokens: Token[] }>>;
  href?: string;
}

export function lexer(src: string): Token[];
