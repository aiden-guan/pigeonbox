import { ensureSurface } from '../shell/surface';

const LABELS: Record<string, string> = {
  RESPOND: 'Respond',
  WAITING: 'Waiting',
  FYI: 'FYI',
  NOTIFICATIONS: 'Notifications',
  PROMOTIONS: 'Promotions',
  NEWS: 'News',
};

export function categoryLabel(category: string | undefined): string {
  if (!category) return '';
  return LABELS[category] || category;
}

export function applyCategoryChip(row: HTMLElement, category: string, manual: boolean): void {
  ensureSurface();
  const label = categoryLabel(category);
  if (!label) return;
  let chip = row.querySelector<HTMLElement>('.gi-cat-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'gi-cat-chip';
    chip.setAttribute('data-gi-ui', 'chip');
    const host = row.querySelector('.y6') || row.querySelector('.bog')?.parentElement || row;
    host.append(chip);
  }
  chip.dataset.category = category;
  chip.dataset.manual = manual ? '1' : '0';
  chip.textContent = manual ? `${label} ·` : label;
  chip.title = manual ? `${label}. You set this category.` : label;
}

export function rowsForThread(threadId: string, root: ParentNode = document): HTMLElement[] {
  const matched = [...root.querySelectorAll<HTMLElement>('tr, [role="row"], [role="listitem"]')].filter((row) =>
    rowHasThreadId(row, threadId),
  );
  return matched.filter((row) => !matched.some((other) => other !== row && other.contains(row)));
}

function rowHasThreadId(row: HTMLElement, threadId: string): boolean {
  const attrs = ['data-legacy-thread-id', 'data-thread-id', 'data-thread-perm-id', 'data-gi-thread-id'];
  const nodes = [row, ...row.querySelectorAll('[data-legacy-thread-id], [data-thread-id], [data-thread-perm-id], [data-gi-thread-id]')];
  for (const node of nodes) {
    for (const attr of attrs) {
      if (node.getAttribute(attr) === threadId) return true;
    }
  }
  return false;
}
