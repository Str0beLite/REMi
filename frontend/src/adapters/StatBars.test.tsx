import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatBars } from './StatBars';

const widths = (html: string) => [...html.matchAll(/width:(\d+)%/g)].map(m => Number(m[1]));

describe('StatBars', () => {
  it('draws the better value as the longer bar, for loss too', () => {
    const html = renderToStaticMarkup(
      <StatBars stats={{ heldoutBase: 0.2, heldoutCandidate: 0.9, lossFirst: 2, lossLast: 0.5 }} />,
    );
    // held-out: base 20%, with it 90%; loss: before 2.0 -> 25%, after 0.5 -> 100%
    expect(widths(html)).toEqual([20, 90, 25, 100]);
  });
});
