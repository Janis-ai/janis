import { describe, expect, it } from 'vitest';
import { splitEmphasis } from './richText';

describe('splitEmphasis', () => {
  it('passes plain text through as a single segment', () => {
    expect(splitEmphasis('hello there')).toEqual([{ kind: 'text', text: 'hello there' }]);
  });

  it('splits bold, italic, strike and code', () => {
    expect(splitEmphasis('a **b** c *d* e ~~f~~ g `h` i')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'italic', text: 'd' },
      { kind: 'text', text: ' e ' },
      { kind: 'strike', text: 'f' },
      { kind: 'text', text: ' g ' },
      { kind: 'code', text: 'h' },
      { kind: 'text', text: ' i' },
    ]);
  });

  it('leaves ordinary asterisks alone', () => {
    expect(splitEmphasis('5 * 3 = 15 * 2')).toEqual([
      { kind: 'text', text: '5 * 3 = 15 * 2' },
    ]);
    expect(splitEmphasis('2**10 is 1024')).toEqual([
      { kind: 'text', text: '2**10 is 1024' },
    ]);
  });

  it('bold and italic adjacent', () => {
    expect(splitEmphasis('**bold** *ital*')).toEqual([
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'ital' },
    ]);
  });
});
