declare module "markdown-it" {
  interface MarkdownToken {
    attrSet(name: string, value: string): void;
  }
  interface MarkdownRenderer {
    rules: Record<string, ((tokens: MarkdownToken[], index: number, options: unknown, environment: unknown, self: MarkdownRenderer) => string) | undefined>;
    renderToken(tokens: MarkdownToken[], index: number, options: unknown): string;
  }
  export default class MarkdownIt {
    constructor(options?: { html?: boolean; linkify?: boolean; breaks?: boolean });
    renderer: MarkdownRenderer;
    render(source: string): string;
  }
}
