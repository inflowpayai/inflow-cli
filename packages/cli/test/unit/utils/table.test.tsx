import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Table, type TableColumn } from '../../../src/utils/table.js';

void React;

function stripAnsi(input: string): string {
  return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

interface Row {
  a: string;
  b: string;
  c?: string;
}

function plainLines(frame: string | undefined): string[] {
  const stripped = stripAnsi(frame ?? '');
  return stripped.split('\n').filter((line) => line.length > 0);
}

function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  expect(line).toBeDefined();
  return line as string;
}

describe('Table — layout', () => {
  it('renders the header row, the dim separator, and one row per data item', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'Aaa', cell: (r) => r.a },
      { header: 'Bbb', cell: (r) => r.b },
    ];
    const { lastFrame, unmount } = render(
      <Table<Row>
        columns={cols}
        rows={[
          { a: 'one', b: 'two' },
          { a: 'three', b: 'four' },
        ]}
      />,
    );
    const lines = plainLines(lastFrame());
    expect(lines).toHaveLength(4);
    unmount();
  });

  it('computes each column width as max(header.length, longestCell.length)', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'X', cell: (r) => r.a },
      { header: 'LongHeaderHere', cell: (r) => r.b },
    ];
    const { lastFrame, unmount } = render(
      <Table<Row>
        columns={cols}
        rows={[
          { a: 'one', b: 'b1' },
          { a: 'medium', b: 'b2' },
        ]}
      />,
    );
    const lines = plainLines(lastFrame());
    expect(lineAt(lines, 0)).toBe('X       LongHeaderHere');
    expect(lineAt(lines, 1)).toBe('------  --------------');
    expect(lineAt(lines, 2)).toBe('one     b1');
    expect(lineAt(lines, 3)).toBe('medium  b2');
    unmount();
  });

  it('separator length under each column equals that column width', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'Aa', cell: (r) => r.a },
      { header: 'Bbb', cell: (r) => r.b },
    ];
    const { lastFrame, unmount } = render(<Table<Row> columns={cols} rows={[{ a: 'hello', b: 'world' }]} />);
    const lines = plainLines(lastFrame());
    expect(lineAt(lines, 1)).toBe('-----  -----');
    unmount();
  });

  it('does not trail-pad the last column header or cells', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'First', cell: (r) => r.a },
      { header: 'Last', cell: (r) => r.b },
    ];
    const { lastFrame, unmount } = render(
      <Table<Row>
        columns={cols}
        rows={[
          { a: 'aa', b: 'short' },
          { a: 'bbb', b: 'much-longer-cell' },
        ]}
      />,
    );
    const lines = plainLines(lastFrame());
    expect(lineAt(lines, 0)).toBe('First  Last');
    expect(lineAt(lines, 0)).not.toMatch(/\s+$/);
    expect(lineAt(lines, 2)).toBe('aa     short');
    expect(lineAt(lines, 2)).not.toMatch(/\s+$/);
    unmount();
  });

  it('uses a 2-space gutter between columns by default', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'A', cell: () => 'x' },
      { header: 'B', cell: () => 'y' },
      { header: 'C', cell: () => 'z' },
    ];
    const { lastFrame, unmount } = render(<Table<Row> columns={cols} rows={[{ a: '', b: '', c: '' }]} />);
    const lines = plainLines(lastFrame());
    expect(lineAt(lines, 2)).toBe('x  y  z');
    unmount();
  });

  it('respects a custom gutter when provided', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'A', cell: () => 'x' },
      { header: 'B', cell: () => 'y' },
    ];
    const { lastFrame, unmount } = render(<Table<Row> columns={cols} rows={[{ a: '', b: '' }]} gutter=" | " />);
    const lines = plainLines(lastFrame());
    expect(lineAt(lines, 0)).toBe('A | B');
    expect(lineAt(lines, 2)).toBe('x | y');
    unmount();
  });

  it('respects minWidth when it exceeds header and longest cell', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'A', cell: (r) => r.a, minWidth: 10 },
      { header: 'B', cell: (r) => r.b },
    ];
    const { lastFrame, unmount } = render(<Table<Row> columns={cols} rows={[{ a: 'x', b: 'y' }]} />);
    const lines = plainLines(lastFrame());
    expect(lineAt(lines, 0)).toBe('A           B');
    expect(lineAt(lines, 1)).toBe('----------  -');
    expect(lineAt(lines, 2)).toBe('x           y');
    unmount();
  });

  it('renders empty rows as just header + separator', () => {
    const cols: TableColumn<Row>[] = [
      { header: 'A', cell: (r) => r.a },
      { header: 'Bb', cell: (r) => r.b },
    ];
    const { lastFrame, unmount } = render(<Table<Row> columns={cols} rows={[]} />);
    const lines = plainLines(lastFrame());
    expect(lines).toEqual(['A  Bb', '-  --']);
    unmount();
  });
});

describe('Table — alignment regression (deposit-addresses col 3)', () => {
  it('aligns the last column at the same character position across rows of varying middle-column lengths', () => {
    interface DepositRow {
      blockchain: string;
      address: string;
      currencies: string;
    }
    const cols: TableColumn<DepositRow>[] = [
      { header: 'Blockchain', cell: (r) => r.blockchain },
      { header: 'Address', cell: (r) => r.address },
      { header: 'Currencies', cell: (r) => r.currencies },
    ];
    const rows: DepositRow[] = [
      {
        blockchain: 'eip155:8453',
        address: '0x4d3a7c0c1f2e9b1d6a8e4f7a3b9c5d2e1f0a8b6c',
        currencies: 'USDC, EURC',
      },
      {
        blockchain: 'solana:1',
        address: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1aBcDeFgHi',
        currencies: 'USDC',
      },
    ];
    const { lastFrame, unmount } = render(<Table<DepositRow> columns={cols} rows={rows} />);
    const lines = plainLines(lastFrame());

    const headerLine = lineAt(lines, 0);
    const headerCurrenciesIdx = headerLine.indexOf('Currencies');
    expect(headerCurrenciesIdx).toBeGreaterThan(0);
    expect(lineAt(lines, 2).indexOf('USDC, EURC')).toBe(headerCurrenciesIdx);
    expect(lineAt(lines, 3).indexOf('USDC')).toBe(headerCurrenciesIdx);
    unmount();
  });
});
