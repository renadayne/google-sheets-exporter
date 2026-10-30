import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Helper: 0-indexed column to letter (0 -> A, 25 -> Z, 26 -> AA)
function colToA1(colIndex) {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

// Helper: 0-indexed [row, col] to A1 coordinate ([0, 0] -> A1, [49, 3] -> D50)
function coordToA1(rowIndex, colIndex) {
  return `${colToA1(colIndex)}${rowIndex + 1}`;
}

const FIXTURES_DIR = path.resolve('tests/fixtures/grid');

function loadJson(filename) {
  const filepath = path.join(FIXTURES_DIR, filename);
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

const results = [];
function recordCheck(name, pass, details = {}) {
  results.push({ name, pass, details });
  const status = pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}`);
  if (!pass) {
    console.error('Details:', details);
  }
}

console.log('=== T03 GridData Fidelity & Visibility Offline Fixture Checker ===\n');

// ---------------------------------------------------------------------------
// 1. Multi-Sheet Fidelity & Invariants Check
// ---------------------------------------------------------------------------
const multiSheetFixture = loadJson('multisheet-fidelity.json');
const multiSheetOracle = loadJson('multisheet-fidelity.oracle.json');

// Invariant: Workbook properties and sheet ordering by explicit properties.index
assert.equal(multiSheetFixture.spreadsheetId, multiSheetOracle.spreadsheetId);
assert.equal(multiSheetFixture.sheets.length, multiSheetOracle.expectedSheetsCount);
recordCheck('Workbook sheet count matches oracle (3 sheets)', multiSheetFixture.sheets.length === 3, {
  actual: multiSheetFixture.sheets.length,
  expected: 3,
});

// Validate sheet order by explicit properties.index
const sortedSheets = [...multiSheetFixture.sheets].sort((a, b) => a.properties.index - b.properties.index);
const sheetOrderMatched = sortedSheets.every((sheet, idx) => {
  const expected = multiSheetOracle.sheetOrderByIndex[idx];
  return (
    sheet.properties.index === expected.index &&
    sheet.properties.sheetId === expected.sheetId &&
    sheet.properties.title === expected.title &&
    sheet.properties.sheetType === expected.sheetType
  );
});
recordCheck('Worksheet ordering validated by explicit properties.index', sheetOrderMatched, {
  indexedOrder: sortedSheets.map(s => ({
    index: s.properties.index,
    title: s.properties.title,
    type: s.properties.sheetType,
  })),
});

// ---------------------------------------------------------------------------
// 2. Validate Every Oracle Expected Cell across All Sheets
// ---------------------------------------------------------------------------
multiSheetOracle.sheets.forEach(oracleSheet => {
  const fixtureSheet = multiSheetFixture.sheets.find(s => s.properties.sheetId === oracleSheet.sheetId);
  assert.ok(fixtureSheet, `Sheet ID ${oracleSheet.sheetId} must exist in fixture`);

  if (!oracleSheet.expectedCells) return;

  oracleSheet.expectedCells.forEach(expected => {
    const chunk = fixtureSheet.data[expected.chunkIndex];
    assert.ok(chunk, `Chunk ${expected.chunkIndex} must exist in sheet ${oracleSheet.title}`);

    const absRow = (chunk.startRow || 0) + expected.relativeRow;
    const absCol = (chunk.startColumn || 0) + expected.relativeCol;
    const computedA1 = coordToA1(absRow, absCol);

    assert.equal(absRow, expected.absoluteRow, `Absolute row mismatch for cell ${expected.a1}`);
    assert.equal(absCol, expected.absoluteCol, `Absolute col mismatch for cell ${expected.a1}`);
    assert.equal(computedA1, expected.a1, `A1 coordinate mismatch for cell ${expected.a1}`);

    const rowObj = chunk.rowData?.[expected.relativeRow];
    const cell = rowObj?.values?.[expected.relativeCol];

    if (expected.isBlankOmission) {
      const hasValue = cell && (cell.effectiveValue !== undefined || cell.userEnteredValue !== undefined);
      assert.ok(!hasValue, `Blank omission cell ${expected.a1} must not contain effective or user values`);
      recordCheck(`Cell ${expected.a1} blank omission verified`, true, { coord: expected.a1 });
      return;
    }

    assert.ok(cell, `Cell ${expected.a1} must exist in chunk rowData`);

    if (expected.isExplicitEmptyString) {
      assert.equal(cell.effectiveValue?.stringValue, '', `Cell ${expected.a1} must have stringValue ""`);
      assert.equal(cell.formattedValue, '', `Cell ${expected.a1} formattedValue must be ""`);
    }

    if (expected.raw !== null && expected.raw !== undefined) {
      const effVal = cell.effectiveValue;
      const rawVal = expected.kind === 'string'
        ? effVal?.stringValue
        : expected.kind === 'number' || expected.kind === 'date_serial'
        ? effVal?.numberValue
        : expected.kind === 'boolean'
        ? effVal?.boolValue
        : undefined;
      assert.equal(rawVal, expected.raw, `Raw value mismatch for cell ${expected.a1}`);
    }

    if (expected.formatted !== null && expected.formatted !== undefined) {
      assert.equal(cell.formattedValue, expected.formatted, `Formatted value mismatch for cell ${expected.a1}`);
    }

    if (expected.isFormula) {
      assert.equal(cell.userEnteredValue?.formulaValue, expected.formulaText, `Formula text mismatch for cell ${expected.a1}`);
    }

    if (expected.kind === 'error') {
      assert.equal(cell.effectiveValue?.errorValue?.type, expected.errorType, `Error type mismatch for cell ${expected.a1}`);
      assert.equal(cell.effectiveValue?.errorValue?.message, expected.errorMessage, `Error message mismatch for cell ${expected.a1}`);
    }

    if (expected.numberFormatType) {
      assert.equal(cell.effectiveFormat?.numberFormat?.type, expected.numberFormatType, `NumberFormat type mismatch for cell ${expected.a1}`);
    }

    if (expected.pattern) {
      assert.equal(cell.effectiveFormat?.numberFormat?.pattern, expected.pattern, `NumberFormat pattern mismatch for cell ${expected.a1}`);
    }

    if (expected.doNotCastToDate) {
      assert.equal(typeof cell.effectiveValue?.numberValue, 'number', `Date cell ${expected.a1} must be raw numeric serial`);
    }

    recordCheck(`Cell ${expected.a1} absolute coord & typed attributes verified (${expected.kind})`, true, {
      coord: expected.a1,
      kind: expected.kind,
      formatted: cell.formattedValue,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Sparse Allocation Invariant Check (Sheet 0)
// ---------------------------------------------------------------------------
const sparseSheet = multiSheetFixture.sheets[0];
const totalAllocatedRows = sparseSheet.data.reduce((sum, chunk) => sum + (chunk.rowData ? chunk.rowData.length : 0), 0);
recordCheck('Sparse sheet does not allocate 90,000 intermediate rowData arrays', totalAllocatedRows === 3, {
  allocatedRows: totalAllocatedRows,
  maxRowIndexReferenced: 89999,
});

// ---------------------------------------------------------------------------
// 4. Merge Validation Function (Iterates every declared non-anchor position)
// ---------------------------------------------------------------------------
function validateMerges(sheetFixture, sheetOracle) {
  if (!sheetOracle.merges) return;

  sheetOracle.merges.forEach(mergeOracle => {
    const fixtureMerge = sheetFixture.merges?.find(
      m =>
        m.startRowIndex === mergeOracle.startRowIndex &&
        m.endRowIndex === mergeOracle.endRowIndex &&
        m.startColumnIndex === mergeOracle.startColumnIndex &&
        m.endColumnIndex === mergeOracle.endColumnIndex
    );
    assert.ok(fixtureMerge, `Merge range ${mergeOracle.a1Range} must exist in fixture`);

    // Verify anchor has value
    const anchor = mergeOracle.anchor;
    const chunk = sheetFixture.data.find(
      c =>
        (c.startRow || 0) <= anchor.absoluteRow &&
        (c.startColumn || 0) <= anchor.absoluteCol
    );
    assert.ok(chunk, `Chunk containing anchor ${anchor.a1} must exist`);

    const relAnchorRow = anchor.absoluteRow - (chunk.startRow || 0);
    const relAnchorCol = anchor.absoluteCol - (chunk.startColumn || 0);
    const anchorCell = chunk.rowData?.[relAnchorRow]?.values?.[relAnchorCol];
    assert.ok(anchorCell?.effectiveValue !== undefined, `Anchor cell ${anchor.a1} must have a value`);

    // Iterate EVERY declared non-anchor position and assert no value
    mergeOracle.nonAnchorPositions.forEach(nonAnchor => {
      const relRow = nonAnchor.absoluteRow - (chunk.startRow || 0);
      const relCol = nonAnchor.absoluteCol - (chunk.startColumn || 0);
      const nonAnchorCell = chunk.rowData?.[relRow]?.values?.[relCol];
      const hasValue = nonAnchorCell && (nonAnchorCell.effectiveValue !== undefined || nonAnchorCell.userEnteredValue !== undefined);
      if (hasValue) {
        throw new Error(`Merged non-anchor cell ${nonAnchor.a1} at [${nonAnchor.absoluteRow}, ${nonAnchor.absoluteCol}] must not have a value`);
      }
    });
  });
}

const typesSheet = multiSheetFixture.sheets[1];
const typesOracle = multiSheetOracle.sheets[1];
validateMerges(typesSheet, typesOracle);
recordCheck('Merged range C5:D5 anchor has value and all non-anchor positions are unpopulated', true, {
  mergeRange: typesOracle.merges[0].a1Range,
  nonAnchorPositionsChecked: typesOracle.merges[0].nonAnchorPositions.map(p => p.a1),
});

// ---------------------------------------------------------------------------
// 5. Dimension Visibility Check by Offsets (Sheet 1)
// ---------------------------------------------------------------------------
const chunk1 = typesSheet.data[0];
typesOracle.visibility.rowMetadata.forEach(expectedRow => {
  const actual = chunk1.rowMetadata?.[expectedRow.offset];
  assert.ok(actual, `rowMetadata at offset ${expectedRow.offset} must exist`);
  assert.equal(actual.hiddenByUser || false, expectedRow.hiddenByUser || false, `hiddenByUser mismatch at row offset ${expectedRow.offset}`);
  assert.equal(actual.hiddenByFilter || false, expectedRow.hiddenByFilter || false, `hiddenByFilter mismatch at row offset ${expectedRow.offset}`);
});
recordCheck('Row visibility metadata offsets validated against oracle', true, {
  checkedOffsets: typesOracle.visibility.rowMetadata.map(r => r.offset),
});

typesOracle.visibility.columnMetadata.forEach(expectedCol => {
  const actual = chunk1.columnMetadata?.[expectedCol.offset];
  assert.ok(actual, `columnMetadata at offset ${expectedCol.offset} must exist`);
  assert.equal(actual.hiddenByUser || false, expectedCol.hiddenByUser || false, `hiddenByUser mismatch at col offset ${expectedCol.offset}`);
});
recordCheck('Column visibility metadata offsets validated against oracle', true, {
  checkedOffsets: typesOracle.visibility.columnMetadata.map(c => c.offset),
});

// ---------------------------------------------------------------------------
// 6. Non-GRID Sheet Limitations (Sheet 2: SummaryChart)
// ---------------------------------------------------------------------------
const objectSheet = multiSheetFixture.sheets[2];
const objectOracle = multiSheetOracle.sheets[2];
const isObjectSheet = objectSheet.properties.sheetType === 'OBJECT';
const hasNoGridData = objectSheet.data === undefined || objectSheet.data.length === 0;
recordCheck('Non-GRID sheet (OBJECT) recognized with limitation warning requirement', isObjectSheet && hasNoGridData, {
  sheetType: objectSheet.properties.sheetType,
  limitation: objectOracle.limitation,
  remedy: objectOracle.remedy,
});

// ---------------------------------------------------------------------------
// 7. Unavailable Visibility Assessment (Missing metadata / provenance)
// ---------------------------------------------------------------------------
const unavailFixture = loadJson('unavailable-visibility.json');
const unavailOracle = loadJson('unavailable-visibility.oracle.json');
const unavailSheet = unavailFixture.sheets[0];
const unavailChunk = unavailSheet.data[0];
const rowMetaMissing = unavailChunk.rowMetadata === undefined || unavailChunk.rowMetadata === null;
const colMetaMissing = unavailChunk.columnMetadata === undefined || unavailChunk.columnMetadata === null;
const hasSavedFilterViews = Array.isArray(unavailSheet.filterViews) && unavailSheet.filterViews.length > 0;

assert.equal(unavailOracle.visibilityAssessment.requiredPolicyAction, 'DISABLE_API_VISIBLE_AND_REQUIRE_USER_CHOICE');
recordCheck('Missing metadata/provenance triggers policy disable of api-visible', rowMetaMissing && colMetaMissing, {
  rowMetadataMissing: rowMetaMissing,
  columnMetadataMissing: colMetaMissing,
  savedFilterViewsPresent: hasSavedFilterViews,
  policyAction: unavailOracle.visibilityAssessment.requiredPolicyAction,
});

// ---------------------------------------------------------------------------
// 8. Temporary Mutation Check: Populated Merged Non-Anchor Is Rejected
// ---------------------------------------------------------------------------
let mutationRejected = false;
const savedCell = chunk1.rowData[0].values[1];
try {
  // Mutate non-anchor D5 with an illegal filled value
  chunk1.rowData[0].values[1] = {
    userEnteredValue: { stringValue: 'illegal-fill-down' },
    effectiveValue: { stringValue: 'illegal-fill-down' },
  };
  validateMerges(typesSheet, typesOracle);
} catch (err) {
  mutationRejected = true;
  assert.match(err.message, /Merged non-anchor cell D5.*must not have a value/);
} finally {
  // Restore original fixture in memory, leaving zero residual mutation artifact
  chunk1.rowData[0].values[1] = savedCell;
}
recordCheck('Temporary mutation check: populated merged non-anchor is rejected and restored', mutationRejected);

// Verify fixture integrity after finally restoration
validateMerges(typesSheet, typesOracle);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n--- Checker Summary ---');
const totalChecks = results.length;
const passedChecks = results.filter(r => r.pass).length;
const failedChecks = results.filter(r => !r.pass).length;

console.log(`Total checks: ${totalChecks}`);
console.log(`Passed: ${passedChecks}`);
console.log(`Failed: ${failedChecks}`);

if (failedChecks > 0) {
  process.exit(1);
} else {
  console.log('\nAll offline GridData fidelity, visibility, and mutation checks PASSED.');
}
