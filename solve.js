// fast-csv: a fast drop-in for csv-reader 1.0.0.
//
// Reads a CSV text once, left to right, and answers {columns, rows, errors}
// exactly as csv-reader 1.0.0 does. The reading policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, and each CRLF or lone CR inside it is
//     read as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character, and the text after it is
//     read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside a quoted field counted),
//     row its record's index in rows (null for the header), in the order met,
//     a field's quote_junk when the field ends and a record's short_row or
//     long_row when the record ends.
//
// Speed comes from never walking the common case one character at a time:
// most records hold no quote and no stray CR, so a whole record is cut out
// with indexOf and split on commas in one go. A record that does hold a
// quote or a stray CR falls back to a per-field scan that still jumps from
// one delimiter to the next with indexOf and only walks character by
// character through the rare broken field itself. Field readers report
// through shared locals instead of fresh objects, so the scan allocates
// almost nothing beyond the answer itself. No state is kept from one call
// to the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The first LF at or after the current position, kept for the slow path's
  // record: an unquoted field that ends at a comma leaves it valid, a quoted
  // field recomputes it, so readUnquoted need not search for it per field.
  let nextLf = -1;

  // The field just read: its value and how it ended. The readers below
  // write these instead of returning a fresh object per field.
  let fValue = '';
  let fEnded = END;

  // Finishes a record: the header is kept as columns, any other record is
  // padded or cut to the first record's width and pushed to rows.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads unquoted characters onto `initial` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). The CR check runs
  // on the field's own slice, never on the rest of the text, so a file with
  // almost no CRs costs nothing extra.
  function readUnquoted(initial) {
    const comma = text.indexOf(',', pos);
    const lf = nextLf;
    let end;
    let ended;
    if (comma !== -1 && (lf === -1 || comma < lf)) {
      end = comma;
      ended = COMMA;
    } else if (lf !== -1) {
      end = lf;
      ended = LINE_BREAK;
    } else {
      end = n;
      ended = END;
    }
    // A CR right before the LF that ends the field is the CRLF ending, not
    // part of the value.
    const crlf = ended === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13;
    const segEnd = crlf ? end - 1 : end;
    const segment = text.slice(pos, segEnd);
    if (segment.indexOf('\r') !== -1) {
      // A stray CR sits inside the field: walk it character by character.
      readUnquotedSlow(initial);
      return;
    }
    fValue = initial === '' ? segment : initial + segment;
    fEnded = ended;
    if (ended === COMMA) pos = end + 1;
    else if (ended === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else pos = end;
  }

  // The slow half of readUnquoted: the field holds a stray CR.
  function readUnquotedSlow(initial) {
    let value = initial;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        continue;
      }
      value += text[pos];
      pos += 1;
    }
    fValue = value;
    fEnded = END;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    const q = text.indexOf('"', pos);
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      nextLf = text.indexOf('\n', pos);
      readUnquoted('"');
      return;
    }
    // A doubled quote, or a line break inside the quotes, needs the slow
    // half: the closing quote is not simply the next quote. Both checks run
    // on the field's own slice, never on the rest of the text.
    if (text.charCodeAt(q + 1) === 34) {
      readQuotedSlow(open, openLine);
      return;
    }
    const value = text.slice(pos, q);
    if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
      readQuotedSlow(open, openLine);
      return;
    }
    const after = q + 1;
    if (after >= n) {
      pos = n;
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(after);
    if (c === 44) {
      pos = after + 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos = after + 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(after + 1) === 10) {
      pos = after + 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    pos = after;
    nextLf = text.indexOf('\n', pos);
    readUnquoted(value);
    if (fValue.length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  // The slow half of readQuoted: the field holds a doubled quote or a line
  // break inside its quotes.
  function readQuotedSlow(open, openLine) {
    let value = '';
    pos = open + 1;
    line = openLine;
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (text.charCodeAt(pos + 1) === 34) {
          value += '"';
          pos += 2;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        value += '\n';
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        continue;
      }
      if (c === 10) line += 1;
      value += text[pos];
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      nextLf = text.indexOf('\n', pos);
      readUnquoted('"');
      return;
    }
    if (pos >= n) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    nextLf = text.indexOf('\n', pos);
    readUnquoted(value);
    if (fValue.length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record holds no quote, so no field is quoted and no
    // quoted field spans lines. When it also holds no stray CR, the whole
    // record is one slice split on commas. Both checks run on the line's
    // own slice, never on the rest of the text.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    const contentEnd = lf !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    if (contentEnd === pos) {
      // A line left with no characters is no record.
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
      continue;
    }
    const lineText = text.slice(pos, contentEnd);
    if (lineText.indexOf('"') === -1 && lineText.indexOf('\r') === -1) {
      const fields = lineText.split(',');
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
      finishRecord(fields);
      continue;
    }

    // Slow path: the record holds a quote or a stray CR, so read it field
    // by field. The fast path above already found the record's first LF.
    nextLf = lf;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) {
        readQuoted();
        if (fEnded === COMMA) nextLf = text.indexOf('\n', pos);
      } else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
