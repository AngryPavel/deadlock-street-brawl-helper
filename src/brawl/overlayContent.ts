/** False means the overlay must show nothing and its window can stay hidden: it draws only while the item draft
 *  screen is on the frame (`draft`), the ability panel is up (`panel`, ~15 s after the draft closes), or the lobby
 *  status dot is showing (`dot`). Kept free of DOM types so the Electron main process can use it too. */
export const overlayHasContent = (s: { draft: boolean; panel: unknown; dot?: unknown } | null): boolean =>
  !!s && (s.draft || !!s.panel || !!s.dot);
