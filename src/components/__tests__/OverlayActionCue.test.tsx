// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OverlayActionCue } from '../../local/OverlayActionCue';

afterEach(cleanup);

describe('OverlayActionCue', () => {
  it('replaces the action decoration on an offer transition and removes it outside the draft', () => {
    const geometry = { itemId: 7, left: 200, top: 280, width: 240, height: 32 };
    const { container, rerender } = render(<OverlayActionCue cue={{ ...geometry, action: 'take' }} />);
    expect(container.querySelector('[data-action="take"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.overlay-action-cue')?.style.left).toBe('200px');
    rerender(<OverlayActionCue cue={{ ...geometry, action: 'reroll', itemId: null }} />);
    expect(container.querySelector('[data-action="take"]')).toBeNull();
    expect(container.querySelectorAll('[data-action="reroll"]')).toHaveLength(1);
    expect(container.querySelector('.overlay-action-cue')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<OverlayActionCue cue={null} />);
    expect(container.childElementCount).toBe(0);
  });
});
