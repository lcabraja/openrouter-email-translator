import parse, { HTMLElement, Node, TextNode } from "node-html-parser";

type HtmlSegment = {
  node: TextNode;
  leadingWhitespace: string;
  trailingWhitespace: string;
  text: string;
};

type PreparedHtml = {
  root: HTMLElement;
  segments: HtmlSegment[];
};

const SKIP_TEXT_TAGS = new Set(["script", "style", "noscript", "svg", "title"]);

export function prepareHtmlForTranslation(html: string): PreparedHtml {
  const root = parse(html, {
    comment: true,
    parseNoneClosedTags: true,
    preserveTagNesting: true,
  });
  const segments: HtmlSegment[] = [];

  visitNode(root, segments);

  return { root, segments };
}

export function renderTranslatedHtml(
  prepared: PreparedHtml,
  translatedSegments: string[],
  detectedLanguage: string,
  targetLanguage: string,
): string {
  if (translatedSegments.length !== prepared.segments.length) {
    throw new Error("Translated HTML segments do not match the extracted segment count");
  }

  prepared.segments.forEach((segment, index) => {
    const translatedText = translatedSegments[index] ?? "";
    segment.node.rawText = `${segment.leadingWhitespace}${translatedText}${segment.trailingWhitespace}`;
  });

  for (const image of prepared.root.querySelectorAll("img")) {
    const existingAlt = image.getAttribute("alt");
    const note = `detected ${detectedLanguage}; translated ${targetLanguage}`;
    image.setAttribute("alt", existingAlt ? `${existingAlt} | ${note}` : note);
  }

  return prepared.root.toString();
}

export function collectHtmlSegments(prepared: PreparedHtml): string[] {
  return prepared.segments.map((segment) => segment.text);
}

export function textToHtml(text: string): string {
  return `<pre style="white-space: pre-wrap; font: inherit;">${escapeHtml(text)}</pre>`;
}

function visitNode(node: Node, segments: HtmlSegment[]): void {
  if (node instanceof TextNode) {
    if (shouldTranslateTextNode(node)) {
      const raw = node.rawText;
      const match = raw.match(/^(\s*)(.*?)(\s*)$/s);

      if (!match) {
        return;
      }

      const leadingWhitespace = match[1] ?? "";
      const text = match[2] ?? "";
      const trailingWhitespace = match[3] ?? "";

      if (text.trim()) {
        segments.push({
          node,
          leadingWhitespace,
          trailingWhitespace,
          text,
        });
      }
    }

    return;
  }

  const parent = node as HTMLElement;

  for (const child of parent.childNodes) {
    visitNode(child, segments);
  }
}

function shouldTranslateTextNode(node: TextNode): boolean {
  if (node.isWhitespace) {
    return false;
  }

  const parentTag = node.parentNode?.tagName?.toLowerCase();

  if (parentTag && SKIP_TEXT_TAGS.has(parentTag)) {
    return false;
  }

  return true;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
