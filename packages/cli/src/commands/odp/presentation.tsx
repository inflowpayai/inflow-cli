import type { TerseOffering } from '@inflowpayai/inflow-core';
import { Box, Text } from 'ink';
import React from 'react';
import { z } from 'zod';
import { Table, type TableColumn } from '../../utils/table.js';

export interface DetailRow {
  field: string;
  value: string;
}

const DETAIL_COLUMNS: ReadonlyArray<TableColumn<DetailRow>> = [
  { header: 'Field', cell: (row) => row.field },
  { header: 'Value', cell: (row) => row.value },
];

export function DetailsTable({ rows }: { rows: DetailRow[] }) {
  return <Table columns={DETAIL_COLUMNS} rows={rows} />;
}

const resourceImagesSchema = z.array(
  z.object({
    alt: z.string().optional(),
    height: z.number().optional(),
    src: z.string(),
    type: z.string().optional(),
    width: z.number().optional(),
  }),
);

interface ImageRow {
  alt: string;
  dimensions: string;
  role: string;
  type: string;
  url: string;
}

const IMAGE_COLUMNS: ReadonlyArray<TableColumn<ImageRow>> = [
  { header: 'Role', cell: (row) => row.role },
  { header: 'Alt text', cell: (row) => row.alt },
  { header: 'Dimensions', cell: (row) => row.dimensions },
  { header: 'Type', cell: (row) => row.type },
  { header: 'URL', cell: (row) => row.url },
];

export function ResourceImages({ images, serviceOrigin }: { images: unknown; serviceOrigin: string }) {
  const parsed = resourceImagesSchema.safeParse(images);
  if (!parsed.success || parsed.data.length === 0) return null;
  const rows: ImageRow[] = parsed.data.map((image, index) => ({
    alt: image.alt ?? '',
    dimensions:
      image.width === undefined
        ? image.height === undefined
          ? ''
          : `? x ${String(image.height)}`
        : `${String(image.width)} x ${image.height === undefined ? '?' : String(image.height)}`,
    role: index === 0 ? 'Primary' : 'Gallery',
    type: image.type ?? '',
    url: absoluteReference(image.src, serviceOrigin),
  }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Images</Text>
      <Table columns={IMAGE_COLUMNS} rows={rows} />
    </Box>
  );
}

export function detail(field: string, value: string, width = 72): DetailRow[] {
  const words = value.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0 || line.length + word.length + 1 <= width) {
      line = line.length === 0 ? word : `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return (lines.length === 0 ? [''] : lines).map((text, index) => ({ field: index === 0 ? field : '', value: text }));
}

export function listed(values: readonly string[]): string {
  return values.length === 0 ? 'None' : values.join(', ');
}

export function absoluteReference(reference: string, serviceOrigin: string): string {
  try {
    const url = new URL(reference, serviceOrigin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : reference;
  } catch {
    return reference;
  }
}

export function formatPrice(price: TerseOffering['price']): string {
  if (price === undefined) return 'Not advertised';
  if (price.type === 'free') return 'Free';
  if (price.type === 'quote') return 'Quote required';
  const amount = stringField(price, 'amount');
  const currency = stringField(price, 'currency');
  if (price.type === 'fixed' && amount !== undefined && currency !== undefined) return `${amount} ${currency}`;
  if (price.type === 'starting_at' && amount !== undefined && currency !== undefined)
    return `From ${amount} ${currency}`;
  const minimum = stringField(price, 'minimum');
  const maximum = stringField(price, 'maximum');
  if (price.type === 'range' && minimum !== undefined && maximum !== undefined && currency !== undefined)
    return `${minimum} - ${maximum} ${currency}`;
  const unit = stringField(price, 'unit');
  if (price.type === 'metered' && amount !== undefined && currency !== undefined && unit !== undefined)
    return `${amount} ${currency} per ${unit}`;
  return price.type;
}

const PRICE_TYPE_DESCRIPTIONS: Record<NonNullable<TerseOffering['price']>['type'], string> = {
  fixed: 'one advertised price',
  free: 'no price is required',
  metered: 'a price per advertised unit',
  quote: 'the price is determined by a later action',
  range: 'an advertised minimum-to-maximum price',
  starting_at: 'the lowest advertised starting price',
};

export function pricePreviewDetails(price: TerseOffering['price']): DetailRow[] {
  if (price === undefined) return [];
  const rows = detail('Type', `${price.type} - ${PRICE_TYPE_DESCRIPTIONS[price.type]}`);
  const amount = stringField(price, 'amount');
  const currency = stringField(price, 'currency');
  const minimum = stringField(price, 'minimum');
  const maximum = stringField(price, 'maximum');
  const unit = stringField(price, 'unit');
  if (amount !== undefined) rows.push(...detail('Amount', amount));
  if (minimum !== undefined) rows.push(...detail('Minimum', minimum));
  if (maximum !== undefined) rows.push(...detail('Maximum', maximum));
  if (currency !== undefined) rows.push(...detail('Currency', currency));
  if (unit !== undefined) rows.push(...detail('Unit', unit));
  return rows;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

export function humanize(value: string): string {
  const spaced = value
    .replaceAll(/[_-]+/gu, ' ')
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .trim();
  return spaced.length === 0 ? value : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function referencedSchema(
  schema: unknown,
  root: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  let definition = record(schema);
  for (let depth = 0; definition !== undefined && root !== undefined && depth < 8; depth += 1) {
    const reference = definition['$ref'];
    if (typeof reference !== 'string' || !reference.startsWith('#/')) return definition;
    let resolved: unknown = root;
    for (const token of reference.slice(2).split('/')) {
      const object = record(resolved);
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if (object === undefined || !Object.hasOwn(object, key)) return definition;
      resolved = object[key];
    }
    const referenced = record(resolved);
    if (referenced === undefined || referenced === definition) return definition;
    definition = referenced;
  }
  return definition;
}

function propertySchema(
  schema: unknown,
  key: string,
  root: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const definition = referencedSchema(schema, root);
  const properties = record(definition?.['properties']);
  return properties === undefined ? undefined : referencedSchema(properties[key], root);
}

function schemaLabel(key: string, schema: unknown, root: Record<string, unknown> | undefined): string {
  const title = referencedSchema(schema, root)?.['title'];
  return typeof title === 'string' && title.length > 0 ? title : humanize(key);
}

function attributeValue(
  value: unknown,
  schema: unknown,
  root: Record<string, unknown> | undefined,
  serviceOrigin: string,
): string {
  const definition = referencedSchema(schema, root);
  if (typeof value === 'string') {
    const format = definition?.['format'];
    return format === 'uri' || format === 'uri-reference' ? absoluteReference(value, serviceOrigin) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'None';
  if (Array.isArray(value)) {
    const itemSchema = definition?.['items'];
    return value.length === 0
      ? 'None'
      : value.map((item) => attributeValue(item, itemSchema, root, serviceOrigin)).join('; ');
  }
  const object = record(value);
  if (object !== undefined) {
    const keys = Object.keys(object).sort();
    if (keys.length === 0) return 'None';
    return keys
      .map((key) => {
        const property = propertySchema(definition, key, root);
        return `${schemaLabel(key, property, root)}: ${attributeValue(object[key], property, root, serviceOrigin)}`;
      })
      .join(', ');
  }
  if (typeof value === 'bigint') return value.toString();
  return 'Unsupported value';
}

export function attributeDetails(
  attributes: Record<string, unknown> | undefined,
  schema: Record<string, unknown> | undefined,
  serviceOrigin: string,
): DetailRow[] {
  if (attributes === undefined) return [];
  const root = record(schema);
  return Object.keys(attributes)
    .sort()
    .flatMap((key) => {
      const definition = propertySchema(root, key, root);
      return detail(
        schemaLabel(key, definition, root),
        attributeValue(attributes[key], definition, root, serviceOrigin),
      );
    });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function Continuation({ command, next }: { command: string; next: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Continuation</Text>
      <DetailsTable
        rows={[{ field: 'Available', value: 'Yes' }, ...detail('Command', `${command} --next ${shellQuote(next)}`)]}
      />
    </Box>
  );
}

export function summarize(value: string, maximum = 48): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
