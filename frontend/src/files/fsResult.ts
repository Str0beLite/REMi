// fs_request result shapes (CONTRACT.md §8 "Browsing a REMi's files").
export type Entry = { name: string; type: 'dir' | 'file' | 'link' | 'other'; size: number; mtime: number };
export type Listing = { path: string; entries: Entry[]; truncated: boolean };
export type Opened = { path: string; size: number; encoding: 'utf8' | 'base64'; data: string; truncated: boolean };

export function sizeLabel(b: number) {
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}
