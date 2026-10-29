import { describe, expect, it } from 'vitest';
import { parseArrayLiteral, toSqlParam } from './sql.js';

describe('parseArrayLiteral', () => {
  it('parses plain, quoted, empty and NULL items', () => {
    expect(parseArrayLiteral('{}')).toEqual([]);
    expect(parseArrayLiteral('{mail_read,calendar_read}')).toEqual(['mail_read', 'calendar_read']);
    expect(parseArrayLiteral('{"a b","",NULL,"NULL"}')).toEqual(['a b', '', null, 'NULL']);
    expect(parseArrayLiteral('{"say \\"hi\\"","back\\\\slash","x,y"}')).toEqual(['say "hi"', 'back\\slash', 'x,y']);
    expect(parseArrayLiteral('{https://www.googleapis.com/auth/gmail.readonly,openid}')).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'openid',
    ]);
  });

  it('round-trips what toSqlParam writes', () => {
    const values = ['plain', 'with space', 'quote"d', 'back\\slash', 'comma,here', '{braces}', ''];
    expect(parseArrayLiteral(toSqlParam(values) as string)).toEqual(values);
  });
});
