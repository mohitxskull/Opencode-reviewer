// Why: Bun 1.4 natively imports `.md` files via `with { type: "text" }` as UTF-8
// strings (both at runtime and in `bun build --compile`), while TypeScript 7.0
// requires an ambient module declaration for `*.md` imports.
declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.wasm" {
  const filePath: string;
  export default filePath;
}
