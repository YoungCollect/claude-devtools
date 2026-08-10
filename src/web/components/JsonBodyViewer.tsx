import { JsonView } from 'react-json-view-lite';

import { pretty } from '../format.js';
import { jsonContainer } from '../json.js';
import { CodeBlock } from './ui.js';

const jsonStyles = {
  container: 'json-viewer-tree',
  childFieldsContainer: 'json-viewer-children',
  basicChildStyle: 'json-viewer-node',
  collapseIcon: 'json-viewer-toggle json-viewer-collapse',
  expandIcon: 'json-viewer-toggle json-viewer-expand',
  collapsedContent: 'json-viewer-collapsed',
  label: 'json-viewer-label',
  clickableLabel: 'json-viewer-label json-viewer-clickable-label',
  nullValue: 'json-viewer-null',
  undefinedValue: 'json-viewer-null',
  numberValue: 'json-viewer-number',
  stringValue: 'json-viewer-string',
  booleanValue: 'json-viewer-boolean',
  otherValue: 'json-viewer-other',
  punctuation: 'json-viewer-punctuation',
  quotesForFieldNames: true,
  stringifyStringValues: true,
  ariaLables: {
    collapseJson: 'Collapse JSON node',
    expandJson: 'Expand JSON node',
  },
};

/**
 * Only the root container is open on arrival, so the tree renders as a list of
 * the body's top-level fields.
 *
 * A request body is a few keys wrapping tens of thousands of tokens: expanding
 * `messages` on sight buried `model`, `tools` and `max_tokens` under a page of
 * content blocks. Level 0 is the root object itself; every field under it
 * starts folded.
 */
function shouldExpandNode(level: number): boolean {
  return level < 1;
}

export function JsonBodyViewer({ value, raw = '' }: { value: unknown; raw?: string }) {
  const data = jsonContainer(value, raw);
  if (!data) return <CodeBlock text={value !== undefined ? pretty(value) : raw} />;

  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-code-border bg-code p-3">
      <JsonView
        data={data}
        style={jsonStyles}
        shouldExpandNode={shouldExpandNode}
        clickToExpandNode
        aria-label="JSON body"
      />
    </div>
  );
}
