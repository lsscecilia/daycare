// Files imported `with { type: "text" }` arrive as strings.
declare module "*.yaml" { const text: string; export default text; }
declare module "*.swift" { const text: string; export default text; }
declare module "*.html" { const text: string; export default text; }
