// Files compiled into the daycare binary, so an install is one file.
import claudeYaml from "../providers/claude.yaml" with { type: "text" };
import providerTemplate from "../providers/_template.yaml" with { type: "text" };
import quickTpl from "../templates/quick.yaml" with { type: "text" };
import featureTpl from "../templates/feature.yaml" with { type: "text" };
import ocrSwift from "../tools/ocr.swift" with { type: "text" };
import roomHtmlText from "../ui/room.html" with { type: "text" };

export const BUILTIN_PROVIDERS: Record<string, string> = { claude: claudeYaml };
export const BUILTIN_TEMPLATES: Record<string, string> = { quick: quickTpl, feature: featureTpl };
// Bun's types treat .html imports as bundles; with type "text" it is a plain string.
export const roomHtml = roomHtmlText as unknown as string;
export { ocrSwift, providerTemplate };
