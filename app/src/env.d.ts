/// <reference types="vite/client" />
declare module '@hyperdx/lucene' {
  const lucene: { parse(text: string): unknown; toString(node: unknown): string }
  export default lucene
}
