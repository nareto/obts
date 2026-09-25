import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('conflict workbench UI contract', () => {
  it('keeps the diff dominant and removes the clipped three-rail layout', async () => {
    const [app, component, queue, styles] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/ConflictWorkbench.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/ConflictQueue.svelte', 'utf8'),
      readFile('frontend/dashboard/src/style.css', 'utf8')
    ]);

    expect(component).toContain('class="conflict-resolution-toolbar"');
    expect(component).toContain('class="conflict-file-navigator"');
    expect(component).toContain('class="diff-hunk-header"');
    expect(component).toContain('class="directory-conflict-panel"');
    expect(component).toContain('Choose the canonical directory outcome');
    expect(component).toContain('No content delta');
    expect(component).toContain("aria-current={activePath === file.path ? 'location' : undefined}");
    expect(component).not.toContain('class="rail right resolution-rail"');
    expect(component).not.toContain('<b>{index + 1}</b>');

    expect(app).toContain('showList={conflictListOpen || !review}');
    expect(queue).toContain('class="conflict-queue-toolbar"');
    expect(queue).toContain('class="conflict-queue-cards"');
    expect(queue).toContain('Review conflict');
    expect(styles).toContain('grid-template-columns: 240px minmax(0, 1fr)');
    expect(styles).toContain('@container (max-width: 1150px)');
    expect(styles).toContain('.directory-conflict-panel');
    expect(styles).toContain('.conflict-review-body');
    expect(styles).toContain('grid-template-columns: 280px minmax(0, 1fr)');
  });

  it('requires a reviewed server-derived result before applying a resolution', async () => {
    const [app, component, client, styles] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/ConflictWorkbench.svelte', 'utf8'),
      readFile('frontend/dashboard/src/api/client.ts', 'utf8'),
      readFile('frontend/dashboard/src/style.css', 'utf8')
    ]);

    expect(component).toContain('class="diff-source-legend"');
    expect(component).toContain('Server main');
    expect(component).toContain('Device: {review.device_name}');
    expect(component).toContain("Colors identify versions, not which changes you've chosen to keep.");
    expect(component).toContain('class="conflict-view-tabs"');
    expect(component).toContain('>Compare</button>');
    expect(component).toContain('>Result</button>');
    expect(component).toContain('Review result');
    expect(component).toContain('Apply resolution');
    expect(component).toContain('Reviewed result');
    expect(component).toContain('Nothing is applied until you choose Apply resolution');
    expect(component).toContain('class="conflict-result"');
    expect(component).toContain('A deletion is not an empty file.');
    expect(component).toContain('onSubmit(submission, preview.tree)');
    expect(component).not.toContain('>Resolve conflict<');

    expect(app).toContain('onPreview={previewResolution}');
    expect(app).toContain('expectedTree');
    expect(client).toContain('/preview');
    expect(client).toContain('expected_tree');
    expect(styles).toContain('.diff-source-legend');
    expect(styles).toContain('.conflict-result');
  });
});
