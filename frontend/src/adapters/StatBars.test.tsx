import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatBars } from './StatBars';

const widths = (html: string) => [...html.matchAll(/width:(\d+)%/g)].map(m => Number(m[1]));

describe('StatBars', () => {
  it('draws each value as its own length on a shared scale', () => {
    const html = renderToStaticMarkup(
      <StatBars stats={{ heldoutBase: 0.2, heldoutCandidate: 0.9, lossFirst: 2, lossLast: 0.5 }} />,
    );
    // unseen: base 20%, with it 90%; loss: before 2.0 -> 100%, after 0.5 -> 25%
    expect(widths(html)).toEqual([20, 90, 100, 25]);
  });
});
