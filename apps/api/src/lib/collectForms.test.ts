import { describe, expect, it } from 'vitest';
import { submitToolArgs } from './collectForms.js';

const formSpec = {
  type: 'form',
  fields: [
    { name: 'cheese', label: 'Best cheese?', type: 'select' },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
};

describe('submitToolArgs', () => {
  it('interpolates {field} placeholders with posted values', () => {
    const args = submitToolArgs(
      { name: 'gsheets_append', args: { spreadsheet_id: '1L4r', range: 'Sheet1!A1' } },
      formSpec,
      { cheese: 'Brie', notes: 'soft' },
      { spreadsheet_id: 'x', range: 'x', values: 'x' },
    );
    expect(args.spreadsheet_id).toBe('1L4r');
    expect(args.range).toBe('Sheet1!A1');
    // unset `values` param defaults to one row of the fields in order —
    // Sheets append takes an array of row arrays
    expect(JSON.parse(String(args.values))).toEqual([['Brie', 'soft']]);
  });

  it('JSON-encodes substitutions inside JSON-structured args', () => {
    const args = submitToolArgs(
      { name: 'gsheets_append', args: { values: '[[{cheese},{notes}]]', spreadsheet_id: 'sid' } },
      formSpec,
      { cheese: 'Brie', notes: 'soft' },
      { values: 'x' },
    );
    expect(JSON.parse(String(args.values))).toEqual([['Brie', 'soft']]);
  });

  it('interpolates {{field}} moustache placeholders the same as {field}', () => {
    const args = submitToolArgs(
      { name: 'gsheets_append', args: { values: '[[{{cheese}},{{notes}}]]', spreadsheet_id: 'sid' } },
      formSpec,
      { cheese: 'Brie', notes: 'soft' },
      { values: 'x' },
    );
    expect(JSON.parse(String(args.values))).toEqual([['Brie', 'soft']]);
  });

  it('a comma-separated cell template becomes one JSON row', () => {
    // Prod bug: the concierge saved "{{a}},{{b}}" — interpolated to
    // "Pizza,x", the sheets body template splices it as JSON and every
    // submit failed. Rebuild it as a single row of cells.
    const args = submitToolArgs(
      { name: 'gsheets_append', args: { values: '{{cheese}},{{notes}}', spreadsheet_id: 'sid' } },
      formSpec,
      { cheese: 'Brie', notes: 'soft' },
      { values: 'x' },
    );
    expect(JSON.parse(String(args.values))).toEqual([['Brie', 'soft']]);
  });

  it('leaves {{secrets.X}} args untouched', () => {
    const args = submitToolArgs(
      { name: 'api_call', args: { token: '{{secrets.TOKEN}}' } },
      formSpec,
      { cheese: 'Brie' },
      { token: 'x' },
    );
    expect(args.token).toBe('{{secrets.TOKEN}}');
  });

  it('leaves args without placeholders untouched and passes unknown fields through', () => {
    const args = submitToolArgs(
      { name: 'hubspot_update', args: { email: '{cheese}', tier: 'vip' } },
      formSpec,
      { cheese: 'Brie' },
      { email: 'x', tier: 'x' },
    );
    expect(args.email).toBe('Brie');
    expect(args.tier).toBe('vip');
    expect(args.values).toBeUndefined(); // no `values` param on this tool
  });
});
