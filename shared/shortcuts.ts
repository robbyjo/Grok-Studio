export const defaultShortcuts: Record<string, string> = {
  newChat: 'Ctrl+N',
  search: 'Ctrl+Shift+F',
  settings: 'Ctrl+,',
  terminal: 'Ctrl+`',
  tasks: 'Ctrl+Shift+T',
};
export function validateShortcuts(input: Record<string, string>) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid shortcuts.');
  const keys = new Set<string>(),
    result: Record<string, string> = {};
  for (const action of Object.keys(defaultShortcuts)) {
    const value = input[action] ?? defaultShortcuts[action];
    if (
      typeof value !== 'string' ||
      value.length > 50 ||
      !/^(Ctrl|Alt)(\+(Shift|Alt))?\+[A-Za-z0-9,`/.]$/.test(value)
    )
      throw new Error('Use Ctrl or Alt, optional Shift or Alt, and one key.');
    const normalized = value.toLowerCase();
    if (['ctrl+s', 'ctrl+w', 'alt+f4'].includes(normalized) || keys.has(normalized))
      throw new Error('Shortcuts must be distinct; save and quit shortcuts are reserved.');
    keys.add(normalized);
    result[action] = value;
  }
  return result;
}
export function matchesShortcut(
  event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; key: string },
  binding: string,
) {
  const parts = binding.toLowerCase().split('+');
  return (
    (event.ctrlKey || event.metaKey) === parts.includes('ctrl') &&
    event.altKey === parts.includes('alt') &&
    event.shiftKey === parts.includes('shift') &&
    event.key.toLowerCase() === parts.at(-1)
  );
}
