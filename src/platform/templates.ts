import { join } from "node:path";
import { Environment, FileSystemLoader } from "nunjucks";

import { projectRoot } from "./paths";

export type TemplateRenderer = (template: string, context: Record<string, unknown>) => string;

export function createTemplateRenderer(
  root = projectRoot,
  globals: Record<string, unknown> = {},
): TemplateRenderer {
  const environment = new Environment(new FileSystemLoader(join(root, "templates")), {
    autoescape: true,
    throwOnUndefined: true,
  });
  for (const [name, value] of Object.entries(globals)) {
    environment.addGlobal(name, value);
  }
  return (template, context) => environment.render(template, context).replace(/\r?\n$/, "");
}
