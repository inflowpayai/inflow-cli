import type { TerseOffering } from '@inflowpayai/inflow-core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  absoluteReference,
  attributeDetails,
  Continuation,
  detail,
  formatPrice,
  humanize,
  listed,
  record,
  shellQuote,
  summarize,
} from '../../../src/commands/odp/presentation.js';

describe('ODP presentation', () => {
  it('formats compact values and wrapped detail rows', () => {
    expect(detail('Description', 'one two three four', 8)).toEqual([
      { field: 'Description', value: 'one two' },
      { field: '', value: 'three' },
      { field: '', value: 'four' },
    ]);
    expect(detail('Empty', '')).toEqual([{ field: 'Empty', value: '' }]);
    expect(listed([])).toBe('None');
    expect(listed(['one', 'two'])).toBe('one, two');
    expect(humanize('request_schemaURL')).toBe('Request schema URL');
    expect(humanize('---')).toBe('---');
    expect(summarize('short', 8)).toBe('short');
    expect(summarize('longer value', 8)).toBe('longer …');
  });

  it('resolves copyable HTTP references without rewriting other schemes or invalid input', () => {
    expect(absoluteReference('/products/plant', 'https://plants.example/catalog')).toBe(
      'https://plants.example/products/plant',
    );
    expect(absoluteReference('mailto:care@plants.example', 'https://plants.example')).toBe(
      'mailto:care@plants.example',
    );
    expect(absoluteReference('/products/plant', 'not an origin')).toBe('/products/plant');
  });

  it.each([
    [undefined, 'Not advertised'],
    [{ type: 'free' }, 'Free'],
    [{ type: 'quote' }, 'Quote required'],
    [{ amount: '0.014', currency: 'USDC', type: 'fixed' }, '0.014 USDC'],
    [{ amount: '0.014', currency: 'USDC', type: 'starting_at' }, 'From 0.014 USDC'],
    [{ currency: 'USDC', maximum: '0.019', minimum: '0.010', type: 'range' }, '0.010 - 0.019 USDC'],
    [{ amount: '0.014', currency: 'USDC', type: 'metered', unit: 'plant' }, '0.014 USDC per plant'],
    [{ type: 'fixed' }, 'fixed'],
  ] satisfies Array<[TerseOffering['price'], string]>)('formats the %# price preview', (price, expected) => {
    expect(formatPrice(price)).toBe(expected);
  });

  it('renders schema-guided dynamic attributes without assuming a product shape', () => {
    const schema = {
      $defs: {
        image: { format: 'uri-reference', title: 'Product image', type: 'string' },
        specifications: {
          properties: {
            color: { title: 'Color', type: 'string' },
            manual: { format: 'uri-reference', title: 'Manual', type: 'string' },
          },
          type: 'object',
        },
      },
      properties: {
        available: { title: 'Available', type: 'boolean' },
        count: { title: 'Count', type: 'number' },
        empty_list: { items: { type: 'string' }, title: 'Empty list', type: 'array' },
        empty_object: { title: 'Empty object', type: 'object' },
        image: { $ref: '#/$defs/image' },
        identifier: { title: 'Identifier' },
        missing: { title: 'Missing' },
        specifications: { $ref: '#/$defs/specifications' },
        tags: { items: { type: 'string' }, title: 'Tags', type: 'array' },
        unsupported: { title: 'Unsupported' },
      },
      type: 'object',
    };

    expect(
      attributeDetails(
        {
          available: true,
          count: 3,
          empty_list: [],
          empty_object: {},
          image: '/images/plant.svg',
          identifier: 12n,
          missing: null,
          specifications: { color: 'Black', manual: '/manuals/plant.pdf' },
          tags: ['indoor', 'green'],
          unsupported: Symbol('value'),
        },
        schema,
        'https://plants.example',
      ),
    ).toEqual([
      { field: 'Available', value: 'true' },
      { field: 'Count', value: '3' },
      { field: 'Empty list', value: 'None' },
      { field: 'Empty object', value: 'None' },
      { field: 'Identifier', value: '12' },
      { field: 'Product image', value: 'https://plants.example/images/plant.svg' },
      { field: 'Missing', value: 'None' },
      {
        field: 'Specifications',
        value: 'Color: Black, Manual: https://plants.example/manuals/plant.pdf',
      },
      { field: 'Tags', value: 'indoor; green' },
      { field: 'Unsupported', value: 'Unsupported value' },
    ]);
    expect(attributeDetails(undefined, schema, 'https://plants.example')).toEqual([]);
    expect(record({ value: true })).toEqual({ value: true });
    expect(record([])).toBeUndefined();
    expect(record(null)).toBeUndefined();
  });

  it('renders a copyable opaque continuation command', () => {
    expect(shellQuote("cursor'one")).toBe("'cursor'\"'\"'one'");
    const frame = render(
      <Continuation command="inflow odp offerings list 'https://plants.example'" next="cursor'one" />,
    ).lastFrame();
    expect(frame).toContain('Continuation');
    expect(frame).toContain('Available');
    expect(frame).toContain('--next');
    expect(frame).toContain("'cursor'\"'\"'one'");
  });
});
