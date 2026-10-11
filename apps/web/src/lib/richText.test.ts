import { describe, expect, it } from 'vitest';
import { plainText, splitBlocks, splitEmphasis } from './richText';

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

  it('splits $…$ math into detexed math segments', () => {
    expect(
      splitEmphasis('angles measuring $x$, $2x$, and $60^\\circ$.'),
    ).toEqual([
      { kind: 'text', text: 'angles measuring ' },
      { kind: 'math', text: 'x' },
      { kind: 'text', text: ', ' },
      { kind: 'math', text: '2x' },
      { kind: 'text', text: ', and ' },
      { kind: 'math', text: '60°' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('keeps emphasis working around math and inside-out', () => {
    expect(splitEmphasis('so **$x^2$** and *plain*')).toEqual([
      { kind: 'text', text: 'so ' },
      { kind: 'bold', text: 'x²' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'plain' },
    ]);
  });

  it('leaves dollar amounts alone', () => {
    expect(splitEmphasis('it costs $5 and $10 total')).toEqual([
      { kind: 'text', text: 'it costs $5 and $10 total' },
    ]);
    expect(splitEmphasis('pay $50 now, $60 later')).toEqual([
      { kind: 'text', text: 'pay $50 now, $60 later' },
    ]);
    expect(splitEmphasis('price is $19')).toEqual([{ kind: 'text', text: 'price is $19' }]);
  });

  it('handles display math and \\(…\\) delimiters', () => {
    expect(splitEmphasis('$$\\frac{1}{2}$$ and \\(\\alpha\\)')).toEqual([
      { kind: 'math', text: '½' },
      { kind: 'text', text: ' and ' },
      { kind: 'math', text: 'α' },
    ]);
  });

  it('math containing asterisks does not pair as emphasis', () => {
    // $a*b$ — the * inside math must not leak an emphasis pair.
    expect(splitEmphasis('note $a*b$ done')).toEqual([
      { kind: 'text', text: 'note ' },
      { kind: 'math', text: 'a×b' },
      { kind: 'text', text: ' done' },
    ]);
  });
});

describe('splitBlocks', () => {
  it('passes a plain paragraph through', () => {
    expect(splitBlocks('just some text')).toEqual([{ kind: 'para', text: 'just some text' }]);
  });

  it('collects one-bullet-per-line lists', () => {
    expect(splitBlocks('Pick one:\n* Small\n* Big\n* Huge')).toEqual([
      { kind: 'para', text: 'Pick one:' },
      { kind: 'list', items: ['Small', 'Big', 'Huge'], ordered: false },
    ]);
  });

  it('collects inline bullet runs on a single line', () => {
    // The concierge incident: "* **A:** … * **B:** …" emitted as one line.
    expect(
      splitBlocks('I can help: * **Manage Agents:** edit settings * **Train:** teach it answers'),
    ).toEqual([
      { kind: 'para', text: 'I can help:' },
      {
        kind: 'list',
        items: ['**Manage Agents:** edit settings', '**Train:** teach it answers'],
        ordered: false,
      },
    ]);
  });

  it('splits a bullet line that carries more inline bullets', () => {
    expect(splitBlocks('* **A** first * **B** second')).toEqual([
      { kind: 'list', items: ['**A** first', '**B** second'], ordered: false },
    ]);
  });

  it('collects dash-marker inline runs — the "- **A:** … - **B:** …" shape', () => {
    expect(
      splitBlocks('Here is what I can do: - **Build:** create agents - **Analyze:** pull stats'),
    ).toEqual([
      { kind: 'para', text: 'Here is what I can do:' },
      {
        kind: 'list',
        items: ['**Build:** create agents', '**Analyze:** pull stats'],
        ordered: false,
      },
    ]);
  });

  it('never splits a prose dash or a single inline item', () => {
    expect(splitBlocks('cost - billed monthly - honestly')).toEqual([
      { kind: 'para', text: 'cost - billed monthly - honestly' },
    ]);
    expect(splitBlocks('try it - **once** and see')).toEqual([
      { kind: 'para', text: 'try it - **once** and see' },
    ]);
  });

  it('numbered lines become ordered lists', () => {
    expect(splitBlocks('Steps:\n1. one\n2. two')).toEqual([
      { kind: 'para', text: 'Steps:' },
      { kind: 'list', items: ['one', 'two'], ordered: true },
    ]);
  });

  it('collects numbered inline runs as ordered lists', () => {
    // Stored concierge reply: "three ways: 1. **A:** … 2. **B:** …" on one line.
    expect(
      splitBlocks('Three ways: 1. **Gaps:** review them 2. **Forms:** finalize 3. **Stats:** pull them'),
    ).toEqual([
      { kind: 'para', text: 'Three ways:' },
      {
        kind: 'list',
        items: ['**Gaps:** review them', '**Forms:** finalize', '**Stats:** pull them'],
        ordered: true,
      },
    ]);
  });

  it('detaches prose glued onto the last list item', () => {
    expect(
      splitBlocks(
        'Options: - **Web Chat:** script-tag widget. - **Email:** Gmail OAuth. - **API:** SDK or raw HTTP. All share one inbox. Want to set one up?',
      ),
    ).toEqual([
      { kind: 'para', text: 'Options:' },
      {
        kind: 'list',
        items: [
          '**Web Chat:** script-tag widget.',
          '**Email:** Gmail OAuth.',
          '**API:** SDK or raw HTTP.',
        ],
        ordered: false,
      },
      { kind: 'para', text: 'All share one inbox. Want to set one up?' },
    ]);
  });

  it('keeps arithmetic and single inline asterisks as paragraphs', () => {
    expect(splitBlocks('5 * 3 = 15')).toEqual([{ kind: 'para', text: '5 * 3 = 15' }]);
    expect(splitBlocks('pick * **one** option below')).toEqual([
      { kind: 'para', text: 'pick * **one** option below' },
    ]);
  });

  it('blank lines separate paragraphs', () => {
    expect(splitBlocks('first\n\nsecond')).toEqual([
      { kind: 'para', text: 'first' },
      { kind: 'para', text: 'second', breakBefore: true },
    ]);
  });

  it('marks paragraph breaks so renderers show a gap — "one.\n\nTwo" must not merge', () => {
    expect(splitBlocks('select **Web Chat**.\n\nYou will see a script tag')).toEqual([
      { kind: 'para', text: 'select **Web Chat**.' },
      { kind: 'para', text: 'You will see a script tag', breakBefore: true },
    ]);
  });

  it('single newlines are line breaks, not paragraph gaps', () => {
    expect(splitBlocks('first\nsecond')).toEqual([
      { kind: 'para', text: 'first' },
      { kind: 'para', text: 'second' },
    ]);
  });

  it('a list after a blank line carries the gap, not its items', () => {
    expect(splitBlocks('pick:\n\n- one\n- two')).toEqual([
      { kind: 'para', text: 'pick:' },
      { kind: 'list', items: ['one', 'two'], ordered: false, breakBefore: true },
    ]);
  });
});

describe('plainText', () => {
  it('strips paired markers and keeps the content', () => {
    expect(plainText('a **bold** and *ital* and `code`')).toBe('a bold and ital and code');
  });

  it('drops stray markers left by truncation', () => {
    expect(plainText('preview cut mid-**word')).toBe('preview cut mid-word');
  });

  it('leaves lone operators alone', () => {
    expect(plainText('5 * 3 = 15 and snake_case')).toBe('5 * 3 = 15 and snake_case');
  });
});
