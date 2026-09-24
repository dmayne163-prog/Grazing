// shpjs ships no type declarations, and @types/shpjs describes an older API.
declare module "shpjs" {
  export function parseZip(
    buffer: ArrayBuffer | Uint8Array,
    whiteList?: string[]
  ): Promise<unknown>;
}
