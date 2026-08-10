import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasXmlStructure,
  parseXmlOutline,
  serializeXmlOutline,
  xmlTextContent,
} from '../src/core/xml-outline.js';

/**
 * The parser is deliberately lenient, which only stays safe if it is also
 * lossless. `serialize(parse(x)) === x` is the property that lets the Structure
 * view be trusted: structure may go unrecognised, but content is never altered.
 *
 * This is not hypothetical. `react-xml-viewer`, the popular React XML renderer,
 * turns `if (a < b && c > d)` into a tag with attributes `b="true" &&="true"`
 * — silently showing something the agent never sent.
 */
const ROUND_TRIP_CASES: [name: string, input: string][] = [
  ['plain prose', 'just some prose'],
  ['balanced tag', '<system-reminder>hello</system-reminder>'],
  ['comparison operators', '<r>if (a < b && c > d) return;</r>'],
  ['generics', '<r>const x: Array<string> = [];</r>'],
  ['bare ampersand', '<r>Use A & B</r>'],
  ['unclosed inner tag', '<r>Wrap it in <div> without closing</r>'],
  ['same tag nested', '<a><a>x</a></a>'],
  ['different tags nested', '<outer>a<inner>b</inner>c</outer>'],
  ['self closing', 'before <br/> after'],
  ['attributes', '<tag type="note" flag>body</tag>'],
  ['attribute containing gt', '<tag title="a > b">body</tag>'],
  ['text around a block', 'lead <r>mid</r> tail'],
  ['sibling blocks', '<a>1</a> and <b>2</b>'],
  ['stray less-than', 'a < b'],
  ['stray greater-than', 'a > b'],
  ['fenced code inside', '<r>\n```ts\nconst x: Array<string> = [];\n```\n</r>'],
  ['empty input', ''],
  ['open with no close', '<r>never closed'],
  ['close with no open', 'never opened</r>'],
  ['markdown body', '<system-reminder>\n# Title\n- a `x<y`\n- b **bold**\n</system-reminder>'],
  ['crlf newlines', '<r>line1\r\nline2</r>'],
  ['deep nesting', '<a><b><c>deep</c></b></a>'],
];

for (const [name, input] of ROUND_TRIP_CASES) {
  test(`round-trips ${name}`, () => {
    assert.equal(serializeXmlOutline(parseXmlOutline(input)), input);
  });
}

test('round-trips randomly assembled fragments', () => {
  const fragments = [
    '<a>',
    '</a>',
    '<b/>',
    'text',
    ' < ',
    ' > ',
    '&',
    '<a href="x">',
    '\n',
    '`code`',
    '</b>',
  ];
  // Deterministic pseudo-random so a failure is reproducible from the seed.
  let seed = 20260810;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let i = 0; i < 3000; i++) {
    let input = '';
    const parts = 1 + Math.floor(next() * 10);
    for (let j = 0; j < parts; j++) {
      input += fragments[Math.floor(next() * fragments.length)];
    }
    assert.equal(serializeXmlOutline(parseXmlOutline(input)), input, `input: ${input}`);
  }
});

test('recognises structure only when a tag is actually balanced', () => {
  assert.equal(hasXmlStructure('<r>x</r>'), true);
  assert.equal(hasXmlStructure('<r>x</r> trailing'), true);
  assert.equal(hasXmlStructure('a < b && c > d'), false);
  assert.equal(hasXmlStructure('plain prose'), false);
  assert.equal(hasXmlStructure('<unclosed>'), false);
});

test('keeps comparison operators as text rather than inventing attributes', () => {
  const nodes = parseXmlOutline('<r>if (a < b && c > d) return;</r>');
  assert.equal(nodes.length, 1);
  const [element] = nodes;
  assert.ok(element && element.type === 'element');
  assert.equal(element.tag, 'r');
  assert.equal(xmlTextContent(element.children), 'if (a < b && c > d) return;');
});

test('pairs the correct close tag when the same name nests', () => {
  const nodes = parseXmlOutline('<a>outer<a>inner</a></a>');
  assert.equal(nodes.length, 1);
  const [outer] = nodes;
  assert.ok(outer && outer.type === 'element');
  assert.equal(xmlTextContent(outer.children), 'outerinner');
  const inner = outer.children.filter((child) => child.type === 'element');
  assert.equal(inner.length, 1);
});

test('captures attributes verbatim without interpreting them', () => {
  const nodes = parseXmlOutline('<tag type="note" title="a > b" flag>body</tag>');
  const [element] = nodes;
  assert.ok(element && element.type === 'element');
  assert.equal(element.attributes, 'type="note" title="a > b" flag');
});
