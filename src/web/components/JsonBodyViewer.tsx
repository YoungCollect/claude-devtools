import { useMemo } from 'react';
import { JsonView } from 'react-json-view-lite';

import { pretty } from '../format.js';
import { jsonContainer, jsonNodeExpansion } from '../json.js';
import { DataSurface, DataSurfaceBody, DataSurfaceHeader } from './DataSurface.js';
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

export function JsonBodyViewer({
  value,
  raw = '',
  expandFields,
}: {
  value: unknown;
  raw?: string;
  /**
   * Top-level fields to open on top of the default. Used by the drill-down from
   * a trace node, which expands the one field that node came out of.
   */
  expandFields?: readonly string[];
}) {
  // Keyed on the field names themselves, not the array identity: a caller that
  // rebuilds the array each render must not re-run the rule and stomp on
  // whatever the user has expanded by hand since.
  const fieldKey = JSON.stringify(expandFields ?? []);
  // Raw-only records parse into a new object, so memoise the container as well;
  // otherwise any parent render would rebuild the expansion rule and overwrite
  // the nodes the user opened or closed by hand.
  const data = useMemo(() => jsonContainer(value, raw), [value, raw]);

  /*
   * Only the root container is open on arrival, so the tree renders as a list
   * of the body's top-level fields.
   *
   * A request body is a few keys wrapping tens of thousands of tokens:
   * expanding `messages` on sight buried `model`, `tools` and `max_tokens`
   * under a page of content blocks. Level 0 is the root object itself; level 1
   * is its fields. A focused drill-down also opens that field's immediate
   * container children: enough to reveal a system block or message object,
   * without recursively unrolling the captured prompt.
   */
  const shouldExpandNode = useMemo(() => {
    const focused = JSON.parse(fieldKey) as string[];
    return jsonNodeExpansion(data, focused);
  }, [data, fieldKey]);

  if (!data) return <CodeBlock text={value !== undefined ? pretty(value) : raw} />;

  return (
    <DataSurface variant="block">
      <DataSurfaceHeader format="json" />
      <DataSurfaceBody maxHeightClass="max-h-[70vh]" className="p-3">
        <JsonView
          data={data}
          style={jsonStyles}
          shouldExpandNode={shouldExpandNode}
          clickToExpandNode
          aria-label="JSON body"
        />
      </DataSurfaceBody>
    </DataSurface>
  );
}
