import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('conflict workbench UI contract', () => {
  it('keeps the diff dominant and removes the clipped three-rail layout', async () => {
    const [app, component, styles] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/ConflictWorkbench.svelte', 'utf8'),
      readFile('frontend/dashboard/src/style.css', 'utf8')
    ]);

    expect(component).toContain('class="conflict-resolution-toolbar"');
    expect(component).toContain('class="conflict-file-navigator"');
    expect(component).toContain('class="diff-hunk-header"');
    expect(component).toContain('No content delta');
    expect(component).toContain("aria-current={activePath === file.path ? 'location' : undefined}");
    expect(component).not.toContain('class="rail right resolution-rail"');
    expect(component).not.toContain('<b>{index + 1}</b>');

    expect(app).toContain('{#if conflictListOpen || !review}');
    expect(app).toContain('class="conflict-queue-toolbar"');
    expect(styles).toContain('grid-template-columns: 240px minmax(0, 1fr)');
    expect(styles).toContain('@container (max-width: 1150px)');
    expect(styles).toContain('.conflict-review-body');
    expect(styles).toContain('grid-template-columns: 280px minmax(0, 1fr)');
  });
});
