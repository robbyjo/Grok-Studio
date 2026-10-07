import { useEffect } from 'react';
export function useAccessibleDialogs() {
  useEffect(() => {
    let previous: HTMLElement | null = null,
      active: HTMLElement | null = null;
    const candidates = (dialog: HTMLElement) =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ),
      ).filter((e) => e.offsetParent !== null);
    const outside = (event: FocusEvent) => {
      if (!active && event.target instanceof HTMLElement) previous = event.target;
    };
    const update = () => {
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const next = dialogs.item(dialogs.length - 1);
      if (next !== active) {
        if (
          !active &&
          document.activeElement instanceof HTMLElement &&
          !next?.contains(document.activeElement)
        )
          previous = document.activeElement;
        active = next;
        if (next) {
          if (!next.contains(document.activeElement)) candidates(next)[0]?.focus();
        } else if (previous?.isConnected) previous.focus();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !active) return;
      const rows = candidates(active);
      if (!rows.length) {
        event.preventDefault();
        return;
      }
      const index = rows.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        rows.at(-1)!.focus();
      } else if (!event.shiftKey && (index < 0 || index === rows.length - 1)) {
        event.preventDefault();
        rows[0].focus();
      }
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', key);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', key);
    };
  }, []);
}
