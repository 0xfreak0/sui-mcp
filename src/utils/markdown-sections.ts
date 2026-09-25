/**
 * Level-2 sections of a Markdown document, picked by heading.
 *
 * A section runs from its `## ` heading to the next `## ` heading, so its `###`
 * subsections come with it. Headings inside fenced code blocks are ignored.
 * Sections are returned in the order asked for, and a heading the document
 * does not have is reported in `missing` rather than skipped silently.
 */
export function markdownSections(markdown: string, headings: string[]): { text: string; missing: string[] } {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.startsWith("## ")) {
      current = [line];
      sections.set(line.slice(3).trim(), current);
      continue;
    }
    if (!fenced && line.startsWith("# ")) {
      current = null;
      continue;
    }
    current?.push(line);
  }

  const picked: string[] = [];
  const missing: string[] = [];
  for (const heading of headings) {
    const lines = sections.get(heading);
    if (lines) picked.push(lines.join("\n").trim());
    else missing.push(heading);
  }
  return { text: picked.join("\n\n"), missing };
}
